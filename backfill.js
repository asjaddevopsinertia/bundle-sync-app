// backfill-pnl-data.js
require('dotenv').config();
const { MongoClient } = require('mongodb');
const axios = require('axios');
const { getAccessToken } = require('./shopify-auth');

// ============================================
// CONFIGURATION
// ============================================

const MONGODB_URI = process.env.MONGODB_URI;
const ORDERS_DB_NAME = process.env.ORDERS_DB_NAME || 'admin';
const CACHE_DB_NAME = process.env.MONGODB_DB || 'shopify-bundles';
const ORDERS_COLLECTION = process.env.ORDERS_COLLECTION || 'orders';

const SHOPIFY_CONFIG = {
  shop: process.env.SHOPIFY_SHOP_DOMAIN,
  apiVersion: '2024-01'
};

const SHIPSTATION_CONFIG = {
  apiKey: process.env.SHIPSTATION_API_KEY,
  apiSecret: process.env.SHIPSTATION_API_SECRET
};

let mongoClient = null;

// ============================================
// MONGODB CONNECTION
// ============================================

async function connectDB() {
  if (!mongoClient) {
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    console.log('✅ Connected to MongoDB');
  }
  return {
    ordersDb: mongoClient.db(ORDERS_DB_NAME),
    cacheDb: mongoClient.db(CACHE_DB_NAME)
  };
}

// ============================================
// SHOPIFY GRAPHQL
// ============================================

async function shopifyGraphQL(query, variables = {}) {
  try {
    const response = await axios.post(
      `https://${SHOPIFY_CONFIG.shop}/admin/api/${SHOPIFY_CONFIG.apiVersion}/graphql.json`,
      { query, variables },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': await getAccessToken()
        }
      }
    );

    if (response.data.errors) {
      console.error('GraphQL Errors:', response.data.errors);
      throw new Error('GraphQL query failed');
    }

    return response.data.data;
  } catch (error) {
    console.error('GraphQL Request Error:', error.response?.data || error.message);
    throw error;
  }
}

// ============================================
// RATE LIMITER
// ============================================

class RateLimiter {
  constructor(maxRequests, windowMs) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.requests = [];
  }

  async waitIfNeeded() {
    const now = Date.now();
    
    // Remove old requests outside the window
    this.requests = this.requests.filter(time => now - time < this.windowMs);

    if (this.requests.length >= this.maxRequests) {
      const oldestRequest = this.requests[0];
      const waitTime = this.windowMs - (now - oldestRequest);
      
      if (waitTime > 0) {
        console.log(`   ⏳ Rate limit reached. Waiting ${(waitTime / 1000).toFixed(1)}s...`);
        await new Promise(resolve => setTimeout(resolve, waitTime + 100));
      }
    }

    this.requests.push(Date.now());
  }
}

const shopifyLimiter = new RateLimiter(2, 1000); // 2 requests per second
const shipstationLimiter = new RateLimiter(40, 60000); // 40 requests per minute

// ============================================
// FETCH PRODUCT COSTS
// ============================================

async function fetchProductCost(productId, variantId, cacheDb) {
  const cache = cacheDb.collection('product_costs_cache');

  // Check cache
  const cached = await cache.findOne({ productId, variantId });
  if (cached && cached.cost !== undefined) {
    return cached.cost;
  }

  const query = `
    query GetProductCosts($id: ID!) {
      product(id: $id) {
        id
        title
        variants(first: 250) {
          nodes {
            id
            title
            sku
            inventoryItem {
              id
              unitCost {
                amount
                currencyCode
              }
            }
          }
        }
      }
    }
  `;

  try {
    await shopifyLimiter.waitIfNeeded();

    const response = await shopifyGraphQL(query, {
      id: `gid://shopify/Product/${productId}`,
    });

    if (!response.product) {
      await cache.updateOne(
        { productId, variantId },
        { 
          $set: { 
            productId, 
            variantId, 
            cost: 0, 
            cachedAt: new Date(),
            backfilled: true
          } 
        },
        { upsert: true }
      );
      return 0;
    }

    // Find matching variant
    const variant = response.product.variants.nodes.find((v) => {
      const nodeId = v.id;
      return nodeId.includes(variantId) || nodeId.endsWith(variantId);
    });

    if (!variant) {
      // Try first variant if no match
      const firstVariant = response.product.variants.nodes[0];
      const cost = firstVariant?.inventoryItem?.unitCost?.amount 
        ? parseFloat(firstVariant.inventoryItem.unitCost.amount) 
        : 0;

      await cache.updateOne(
        { productId, variantId },
        { 
          $set: { 
            productId, 
            variantId, 
            cost, 
            productTitle: response.product.title,
            variantSku: firstVariant?.sku,
            cachedAt: new Date(),
            backfilled: true,
            fallbackUsed: true
          } 
        },
        { upsert: true }
      );
      return cost;
    }

    const costValue = variant.inventoryItem?.unitCost?.amount;
    const cost = costValue !== null && costValue !== undefined ? parseFloat(costValue) : 0;

    await cache.updateOne(
      { productId, variantId },
      { 
        $set: { 
          productId, 
          variantId, 
          cost, 
          productTitle: response.product.title,
          variantSku: variant.sku,
          cachedAt: new Date(),
          backfilled: true
        } 
      },
      { upsert: true }
    );

    return cost;
  } catch (error) {
    console.error(`   ❌ Error fetching cost for product ${productId}:`, error.message);
    return 0;
  }
}

// ============================================
// FETCH SHIPPING COSTS FROM SHOPIFY EVENTS
// ============================================

async function fetchShippingCostFromShopifyEvents(orderId) {
  try {
    await shopifyLimiter.waitIfNeeded();

    const response = await axios.get(
      `https://${SHOPIFY_CONFIG.shop}/admin/api/${SHOPIFY_CONFIG.apiVersion}/orders/${orderId}/events.json`,
      {
        headers: {
          'X-Shopify-Access-Token': await getAccessToken(),
          'Content-Type': 'application/json',
        },
        timeout: 10000
      }
    );

    const events = response.data?.events || [];

    for (const event of events) {
      if (
        event.verb === "shipping_label_created_success" &&
        event.message &&
        event.message.includes('purchased a $') &&
        event.message.includes('shipping label')
      ) {
        const match = event.message.match(/purchased a \$([0-9.]+) shipping label/);
        if (match) {
          return parseFloat(match[1]);
        }
      }
    }

    return null;
  } catch (error) {
    if (error.response?.status === 429) {
      console.log(`   ⚠️  Shopify rate limited`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      return null;
    }
    if (error.response?.status === 404) {
      return null; // Order not found
    }
    if (error.code !== 'ECONNABORTED') {
      console.error(`   ❌ Shopify Events error:`, error.message);
    }
    return null;
  }
}

// ============================================
// FETCH SHIPPING COSTS FROM SHIPSTATION
// ============================================

async function fetchShippingCostFromShipStation(orderNumber) {
  if (!SHIPSTATION_CONFIG.apiKey || !SHIPSTATION_CONFIG.apiSecret) {
    return null;
  }

  try {
    await shipstationLimiter.waitIfNeeded();

    const auth = Buffer.from(
      `${SHIPSTATION_CONFIG.apiKey}:${SHIPSTATION_CONFIG.apiSecret}`
    ).toString('base64');

    const response = await axios.get('https://ssapi.shipstation.com/shipments', {
      params: { orderNumber },
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000
    });

    const shipments = response.data?.shipments;
    if (shipments && shipments.length > 0) {
      const shipment = shipments[0];
      if (shipment.shipmentCost !== null && shipment.shipmentCost !== undefined) {
        return parseFloat(shipment.shipmentCost);
      }
    }

    return null;
  } catch (error) {
    if (error.response?.status === 429) {
      console.log(`   ⚠️  ShipStation rate limited, will retry later`);
      return null;
    }
    if (error.code !== 'ECONNABORTED') {
      console.error(`   ❌ ShipStation error:`, error.message);
    }
    return null;
  }
}

// ============================================
// FETCH SHIPPING COSTS - CHECK BOTH SOURCES
// ============================================

async function fetchAndCacheShippingCost(orderId, orderNumber, cacheDb) {
  const cache = cacheDb.collection('shipping_costs_cache_2');

  // Check cache
  const cached = await cache.findOne({ orderId });
  if (cached && cached.status === 'found' && cached.shippingCost > 0) {
    return { cost: cached.shippingCost, source: cached.source };
  }

  let shippingCost = null;
  let source = null;

  // Try ShipStation first
  if (SHIPSTATION_CONFIG.apiKey && SHIPSTATION_CONFIG.apiSecret) {
    shippingCost = await fetchShippingCostFromShipStation(orderNumber);
    if (shippingCost !== null && shippingCost > 0) {
      source = 'shipstation';
    }
  }

  // If not found in ShipStation, try Shopify Events
  if (shippingCost === null || shippingCost === 0) {
    shippingCost = await fetchShippingCostFromShopifyEvents(orderId);
    if (shippingCost !== null && shippingCost > 0) {
      source = 'shopify_events';
    }
  }

  // Cache the result
  if (shippingCost !== null && shippingCost > 0) {
    await cache.updateOne(
      { orderId },
      {
        $set: {
          orderId,
          orderNumber,
          shippingCost,
          source,
          status: 'found',
          fetchedAt: new Date(),
          backfilled: true
        },
      },
      { upsert: true }
    );
    return { cost: shippingCost, source };
  }

  // Cache as not found (tried both sources)
  await cache.updateOne(
    { orderId },
    {
      $set: {
        orderId,
        orderNumber,
        shippingCost: 0,
        source: 'not_found_both',
        status: 'pending',
        fetchedAt: new Date(),
        backfilled: true,
        checkedShipStation: SHIPSTATION_CONFIG.apiKey ? true : false,
        checkedShopify: true
      },
    },
    { upsert: true }
  );

  return { cost: 0, source: 'not_found_both' };
}

// ============================================
// MAIN BACKFILL PROCESS
// ============================================

async function backfillPNLData(months = 3, maxOrders = null) {
  console.log('\n' + '='.repeat(80));
  console.log(`🔄 BACKFILLING PNL DATA FOR LAST ${months} MONTHS`);
  console.log('='.repeat(80) + '\n');

  const { ordersDb, cacheDb } = await connectDB();

  // Calculate date range correctly (go BACK in time)
  const endDate = new Date();
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - months);
  startDate.setHours(0, 0, 0, 0);
  endDate.setHours(23, 59, 59, 999);

  console.log(`📅 Date Range:`);
  console.log(`   Start: ${startDate.toISOString()} (${startDate.toLocaleString()})`);
  console.log(`   End:   ${endDate.toISOString()} (${endDate.toLocaleString()})\n`);

  // Get orders collection
  const orders = ordersDb.collection(ORDERS_COLLECTION);
  
  // Check what date field exists in your orders
  console.log('🔍 Checking order date field format...\n');
  const sampleOrder = await orders.findOne({});
  
  if (!sampleOrder) {
    console.log('❌ No orders found in collection\n');
    return;
  }

  console.log('📋 Sample order structure:');
  console.log(`   ID: ${sampleOrder.id || sampleOrder._id}`);
  console.log(`   created_at: ${sampleOrder.created_at} (type: ${typeof sampleOrder.created_at})`);
  console.log(`   order_number: ${sampleOrder.order_number || sampleOrder.name}\n`);

  // Build query based on actual date format
  let query;
  
  if (typeof sampleOrder.created_at === 'string') {
    query = {
      created_at: { 
        $gte: startDate.toISOString(), 
        $lte: endDate.toISOString() 
      }
    };
  } else if (sampleOrder.created_at instanceof Date) {
    query = {
      created_at: { 
        $gte: startDate, 
        $lte: endDate 
      }
    };
  } else {
    console.log('❌ Unknown date format in orders collection\n');
    return;
  }

  // Add filters for non-cancelled orders
  query.$or = [
    { financial_status: { $ne: 'cancelled' } },
    { cancelled_at: { $exists: false } },
    { cancelled_at: null }
  ];

  // Count matching orders first
  const orderCount = await orders.countDocuments(query);
  console.log(`📊 Found ${orderCount} orders matching criteria\n`);

  if (orderCount === 0) {
    console.log('ℹ️  No orders found. Checking total orders in collection...');
    const totalOrders = await orders.countDocuments();
    console.log(`   Total orders in collection: ${totalOrders}\n`);
    
    if (totalOrders > 0) {
      const recentOrder = await orders.findOne({}, { sort: { created_at: -1 } });
      console.log(`   Most recent order date: ${recentOrder?.created_at}\n`);
    }
    
    return;
  }

  // Fetch orders (limit if maxOrders is set)
  console.log('📥 Fetching orders...\n');
  let orderQuery = orders.find(query);
  
  if (maxOrders) {
    orderQuery = orderQuery.limit(maxOrders);
    console.log(`   ⚠️  Limited to ${maxOrders} orders for testing\n`);
  }
  
  const orderData = await orderQuery.toArray();

  console.log(`✅ Retrieved ${orderData.length} orders\n`);

  // Statistics
  const stats = {
    totalOrders: orderData.length,
    processedOrders: 0,
    productCostsFetched: 0,
    productCostsCached: 0,
    shippingCostsFetched: 0,
    shippingCostsCached: 0,
    errors: 0
  };

  // Track unique product variants
  const uniqueProducts = new Map();
  const uniqueShipping = new Map();

  // Step 1: Collect all unique product variants
  console.log('📊 Step 1: Analyzing product variants...\n');
  
  for (const order of orderData) {
    if (order.line_items && order.line_items.length > 0) {
      for (const item of order.line_items) {
        const productId = item.product_id?.toString();
        const variantId = item.variant_id?.toString();
        
        if (productId && variantId) {
          const key = `${productId}-${variantId}`;
          if (!uniqueProducts.has(key)) {
            uniqueProducts.set(key, { 
              productId, 
              variantId, 
              sku: item.sku, 
              title: item.title,
              name: item.name
            });
          }
        }
      }
    }

    const orderId = order.id?.toString() || order._id?.toString();
    const orderNumber = order.order_number || order.name;
    uniqueShipping.set(orderId, orderNumber);
  }

  console.log(`   ✅ Found ${uniqueProducts.size} unique product variants`);
  console.log(`   ✅ Found ${uniqueShipping.size} orders for shipping costs\n`);

  if (uniqueProducts.size === 0) {
    console.log('⚠️  No line items found in orders\n');
  }

  // Step 2: Fetch product costs
  if (uniqueProducts.size > 0) {
    console.log('💰 Step 2: Fetching product costs from Shopify...\n');

    let productProgress = 0;
    for (const [key, { productId, variantId, sku, title, name }] of uniqueProducts) {
      productProgress++;
      
      const displayName = sku || name || title || productId;
      process.stdout.write(`   [${productProgress}/${uniqueProducts.size}] ${displayName}...`);

      try {
        const cost = await fetchProductCost(productId, variantId, cacheDb);
        
        if (cost > 0) {
          stats.productCostsFetched++;
          console.log(` ✅ $${cost.toFixed(2)}`);
        } else {
          stats.productCostsCached++;
          console.log(` ⚠️  $0.00 (no cost found)`);
        }
      } catch (error) {
        stats.errors++;
        console.log(` ❌ Error: ${error.message}`);
      }

      // Small delay to avoid rate limits
      if (productProgress < uniqueProducts.size) {
        await new Promise(resolve => setTimeout(resolve, 600));
      }
    }

    console.log(`\n   ✅ Product costs complete: ${stats.productCostsFetched} found, ${stats.productCostsCached} cached\n`);
  }

  // Step 3: Fetch shipping costs from BOTH sources
  console.log('🚚 Step 3: Fetching shipping costs from ShipStation AND Shopify...\n');

  let shippingProgress = 0;
  let fromShipStation = 0;
  let fromShopify = 0;
  let notFound = 0;

  for (const [orderId, orderNumber] of uniqueShipping) {
    shippingProgress++;
    
    process.stdout.write(`   [${shippingProgress}/${uniqueShipping.size}] ${orderNumber}...`);

    try {
      const result = await fetchAndCacheShippingCost(orderId, orderNumber, cacheDb);
      
      if (result.cost > 0) {
        stats.shippingCostsFetched++;
        
        if (result.source === 'shipstation') {
          fromShipStation++;
          console.log(` ✅ $${result.cost.toFixed(2)} [ShipStation]`);
        } else if (result.source === 'shopify_events') {
          fromShopify++;
          console.log(` ✅ $${result.cost.toFixed(2)} [Shopify]`);
        } else {
          console.log(` ✅ $${result.cost.toFixed(2)}`);
        }
      } else {
        stats.shippingCostsCached++;
        notFound++;
        console.log(` ⚠️  $0.00 (not found in either)`);
      }
    } catch (error) {
      stats.errors++;
      console.log(` ❌ Error: ${error.message}`);
    }

    // Rate limit delay (slower to check both sources)
    if (shippingProgress < uniqueShipping.size) {
      await new Promise(resolve => setTimeout(resolve, 800));
    }
  }

  console.log(`\n   ✅ Shipping costs complete:`);
  console.log(`      - From ShipStation: ${fromShipStation}`);
  console.log(`      - From Shopify: ${fromShopify}`);
  console.log(`      - Not found: ${notFound}\n`);

  // Final summary
  console.log('\n' + '='.repeat(80));
  console.log('📊 BACKFILL COMPLETE - SUMMARY');
  console.log('='.repeat(80));
  console.log(`
  Date Range:              ${startDate.toLocaleDateString()} to ${endDate.toLocaleDateString()}
  Orders Processed:        ${stats.totalOrders.toLocaleString()} (of ${orderCount.toLocaleString()} total)
  
  Product Costs:
    - Fetched from Shopify: ${stats.productCostsFetched}
    - Cached (not found):   ${stats.productCostsCached}
    - Total Variants:       ${uniqueProducts.size}
  
  Shipping Costs:
    - From ShipStation:     ${fromShipStation}
    - From Shopify Events:  ${fromShopify}
    - Not found:            ${notFound}
    - Total Orders:         ${uniqueShipping.size}
  
  Errors:                  ${stats.errors}
  `);
  console.log('='.repeat(80) + '\n');

  // Show cache statistics
  const productCostCount = await cacheDb.collection('product_costs_cache').countDocuments();
  const shippingCostCount = await cacheDb.collection('shipping_costs_cache_2').countDocuments();
  const shippingFound = await cacheDb.collection('shipping_costs_cache_2').countDocuments({ status: 'found' });

  console.log('💾 Cache Statistics:\n');
  console.log(`   Product Costs Cache:     ${productCostCount} entries`);
  console.log(`   Shipping Costs Cache:    ${shippingCostCount} entries`);
  console.log(`   Shipping Costs Found:    ${shippingFound} entries`);
  console.log(`   Coverage:                ${((shippingFound / shippingCostCount) * 100).toFixed(2)}%\n`);

  if (maxOrders) {
    console.log(`ℹ️  Note: This was a limited run with ${maxOrders} orders.\n`);
    console.log(`   To process all ${orderCount} orders, run without limit.\n`);
  }
}

// ============================================
// RETRY FAILED SHIPPING COSTS
// ============================================

async function retryFailedShippingCosts() {
  console.log('\n' + '='.repeat(80));
  console.log('🔄 RETRYING FAILED SHIPPING COSTS (CHECKING BOTH SOURCES)');
  console.log('='.repeat(80) + '\n');

  const { cacheDb } = await connectDB();
  const cache = cacheDb.collection('shipping_costs_cache_2');

  // Find pending/failed shipping costs
  const pending = await cache.find({
    $or: [
      { status: 'pending' },
      { status: 'not_found_both' },
      { shippingCost: 0, status: { $ne: 'found' } }
    ]
  }).toArray();

  console.log(`📦 Found ${pending.length} pending shipping costs to retry\n`);

  if (pending.length === 0) {
    console.log('✅ No pending shipping costs\n');
    return;
  }

  let retried = 0;
  let foundShipStation = 0;
  let foundShopify = 0;
  let stillNotFound = 0;

  for (const entry of pending) {
    retried++;
    
    process.stdout.write(`   [${retried}/${pending.length}] ${entry.orderNumber}...`);

    let shippingCost = null;
    let source = null;

    // Try ShipStation
    shippingCost = await fetchShippingCostFromShipStation(entry.orderNumber);
    if (shippingCost !== null && shippingCost > 0) {
      source = 'shipstation';
      foundShipStation++;
    }

    // If not found, try Shopify
    if (shippingCost === null || shippingCost === 0) {
      shippingCost = await fetchShippingCostFromShopifyEvents(entry.orderId);
      if (shippingCost !== null && shippingCost > 0) {
        source = 'shopify_events';
        foundShopify++;
      }
    }

    if (shippingCost !== null && shippingCost > 0) {
      await cache.updateOne(
        { orderId: entry.orderId },
        {
          $set: {
            shippingCost,
            source,
            status: 'found',
            fetchedAt: new Date(),
            retriedAt: new Date()
          }
        }
      );
      console.log(` ✅ $${shippingCost.toFixed(2)} [${source}]`);
    } else {
      await cache.updateOne(
        { orderId: entry.orderId },
        {
          $set: {
            retriedAt: new Date(),
            retryAttempts: (entry.retryAttempts || 0) + 1,
            status: 'not_found_both'
          }
        }
      );
      stillNotFound++;
      console.log(` ⚠️  Still not found (checked both)`);
    }

    await new Promise(resolve => setTimeout(resolve, 800));
  }

  console.log(`\n✅ Retry complete:`);
  console.log(`   - Found in ShipStation: ${foundShipStation}`);
  console.log(`   - Found in Shopify: ${foundShopify}`);
  console.log(`   - Still not found: ${stillNotFound}\n`);
}

// ============================================
// CLI INTERFACE
// ============================================

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'backfill';
  const months = parseInt(args[1]) || 3;
  const maxOrders = args[2] ? parseInt(args[2]) : null;

  try {
    switch (command) {
      case 'backfill':
        await backfillPNLData(months, maxOrders);
        break;
      
      case 'retry':
        await retryFailedShippingCosts();
        break;
      
      case 'both':
        await backfillPNLData(months, maxOrders);
        console.log('\n⏳ Waiting 5 seconds before retry...\n');
        await new Promise(resolve => setTimeout(resolve, 5000));
        await retryFailedShippingCosts();
        break;
      
      default:
        console.log(`
Usage: node backfill-pnl-data.js [command] [months] [maxOrders]

Commands:
  backfill [months] [maxOrders]  - Backfill PNL data for last N months
  retry                          - Retry failed shipping cost lookups
  both [months] [maxOrders]      - Run backfill then retry

Examples:
  node backfill-pnl-data.js backfill 3          # All orders from last 3 months
  node backfill-pnl-data.js backfill 3 100      # First 100 orders (testing)
  node backfill-pnl-data.js retry               # Retry failed shipping costs
  node backfill-pnl-data.js both 6              # Backfill 6 months then retry
        `);
    }
  } catch (error) {
    console.error('\n❌ Fatal Error:', error.message);
    console.error(error.stack);
  } finally {
    if (mongoClient) {
      await mongoClient.close();
      console.log('✅ MongoDB connection closed\n');
    }
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { backfillPNLData, retryFailedShippingCosts };