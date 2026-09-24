// server.js
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
const cors = require('cors');
app.use(cors());

// ============================================
// MONGODB CONNECTION
// ============================================

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || 'shopify-bundles';

let mongoClient = null;
let db = null;

async function connectDB() {
  if (!mongoClient) {
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    console.log('✅ Connected to MongoDB');
    db = mongoClient.db(DB_NAME);

    // Create indexes
    await createIndexes();
  }
  return db;
}

async function createIndexes() {
  try {
    const db = await connectDB();

    // Component Sales Indexes
    const componentSales = db.collection('componentSales');
    await componentSales.createIndex({ componentSku: 1, orderDate: -1 });
    await componentSales.createIndex({ orderDate: -1, action: 1 });
    await componentSales.createIndex({ componentSku: 1, action: 1, orderDate: -1 });
    await componentSales.createIndex({ saleType: 1, orderDate: -1 });
    await componentSales.createIndex({ orderId: 1 });
    await componentSales.createIndex({ processedAt: -1 });

    // Bundle Sales Indexes
    const bundleSales = db.collection('bundleSales');
    await bundleSales.createIndex({ bundleSku: 1, orderDate: -1 });
    await bundleSales.createIndex({ orderDate: -1, action: 1 });
    await bundleSales.createIndex({ orderId: 1 });

    // Daily Component Summary Indexes
    const dailyComponentSummary = db.collection('dailyComponentSummary');
    await dailyComponentSummary.createIndex({ date: 1, componentSku: 1 }, { unique: true });
    await dailyComponentSummary.createIndex({ date: -1 });

    // Daily Bundle Summary Indexes
    const dailyBundleSummary = db.collection('dailyBundleSummary');
    await dailyBundleSummary.createIndex({ date: 1, bundleSku: 1 }, { unique: true });
    await dailyBundleSummary.createIndex({ date: -1 });

    console.log('✅ MongoDB indexes created');
  } catch (error) {
    console.error('❌ Error creating indexes:', error.message);
  }
}

// Initialize DB connection on startup
connectDB().catch(err => {
  console.error('❌ Failed to connect to MongoDB:', err);
  process.exit(1);
});

// ============================================
// MONGODB HELPER FUNCTIONS
// ============================================

// Save component sale
async function saveComponentSale(saleData) {
  try {
    const db = await connectDB();
    const collection = db.collection('componentSales');

    const result = await collection.insertOne({
      ...saleData,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    const saleTypeIcon = saleData.saleType === 'direct' ? '🛒' : '📦';
    console.log(`💾 ${saleTypeIcon} Component: ${saleData.componentSku} (${saleData.quantitySold}x) - $${saleData.totalPrice.toFixed(2)} [${saleData.saleType}]`);

    return result;
  } catch (error) {
    console.error('❌ Error saving component sale:', error.message);
    throw error;
  }
}

// Save bundle sale
async function saveBundleSale(saleData) {
  try {
    const db = await connectDB();
    const collection = db.collection('bundleSales');

    const result = await collection.insertOne({
      ...saleData,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    console.log(`💾 📦 Bundle: ${saleData.bundleSku} (${saleData.quantitySold}x) - $${saleData.totalPrice.toFixed(2)}`);

    return result;
  } catch (error) {
    console.error('❌ Error saving bundle sale:', error.message);
    throw error;
  }
}

// Update daily component summary
async function updateDailyComponentSummary(componentSku, date) {
  try {
    const db = await connectDB();
    const componentSales = db.collection('componentSales');
    const dailySummary = db.collection('dailyComponentSummary');

    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    // Aggregate sales for this component on this day
    const aggregation = await componentSales.aggregate([
      {
        $match: {
          componentSku: componentSku,
          orderDate: { $gte: startOfDay, $lte: endOfDay }
        }
      },
      {
        $group: {
          _id: null,
          productName: { $first: '$componentProductName' },
          weight: { $first: '$weight' },
          totalSold: {
            $sum: {
              $cond: [{ $eq: ['$action', 'sale'] }, '$quantitySold', 0]
            }
          },
          totalRefunded: {
            $sum: {
              $cond: [{ $in: ['$action', ['refund', 'cancellation']] }, '$quantitySold', 0]
            }
          },
          directSales: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$action', 'sale'] },
                    { $eq: ['$saleType', 'direct'] }
                  ]
                },
                '$quantitySold',
                0
              ]
            }
          },
          bundleSales: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$action', 'sale'] },
                    { $eq: ['$saleType', 'bundle'] }
                  ]
                },
                '$quantitySold',
                0
              ]
            }
          },
          totalRevenue: {
            $sum: {
              $cond: [{ $eq: ['$action', 'sale'] }, '$totalPrice', 0]
            }
          },
          totalCost: {
            $sum: {
              $cond: [{ $eq: ['$action', 'sale'] }, '$totalCost', 0]
            }
          },
          orderCount: { $sum: 1 }
        }
      }
    ]).toArray();

    if (aggregation.length > 0) {
      const stats = aggregation[0];
      const netSold = stats.totalSold - stats.totalRefunded;
      const totalProfit = stats.totalRevenue - stats.totalCost;

      await dailySummary.updateOne(
        {
          date: startOfDay,
          componentSku: componentSku
        },
        {
          $set: {
            componentProductName: stats.productName,
            weight: stats.weight,
            totalSold: stats.totalSold,
            totalRefunded: stats.totalRefunded,
            netSold: netSold,
            directSales: stats.directSales,
            bundleSales: stats.bundleSales,
            totalRevenue: stats.totalRevenue,
            totalCost: stats.totalCost,
            totalProfit: totalProfit,
            orderCount: stats.orderCount,
            lastUpdated: new Date(),
            updatedAt: new Date()
          },
          $setOnInsert: {
            createdAt: new Date()
          }
        },
        { upsert: true }
      );
    }
  } catch (error) {
    console.error('❌ Error updating daily component summary:', error.message);
  }
}

// Update daily bundle summary
// Update daily bundle summary
async function updateDailyBundleSummary(bundleSku, date) {
  try {
    const db = await connectDB();
    const bundleSales = db.collection('bundleSales');
    const dailySummary = db.collection('dailyBundleSummary');
    
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);
    
    const aggregation = await bundleSales.aggregate([
      {
        $match: {
          bundleSku: bundleSku,
          orderDate: { $gte: startOfDay, $lte: endOfDay }
        }
      },
      {
        $group: {
          _id: null,
          productName: { $first: '$bundleProductName' },
          totalSold: {
            $sum: {
              $cond: [{ $eq: ['$action', 'sale'] }, '$quantitySold', 0]
            }
          },
          totalRefunded: {
            $sum: {
              $cond: [{ $in: ['$action', ['refund', 'cancellation']] }, '$quantitySold', 0]
            }
          },
          // 🔥 Track fulfilled bundles
          fulfilledSold: {
            $sum: {
              $cond: [
                { $and: [
                  { $eq: ['$action', 'sale'] },
                  { $eq: ['$isFulfilled', true] }
                ]},
                '$quantitySold',
                0
              ]
            }
          },
          // 🔥 Track unfulfilled bundles
          unfulfilledSold: {
            $sum: {
              $cond: [
                { $and: [
                  { $eq: ['$action', 'sale'] },
                  { $eq: ['$isFulfilled', false] }
                ]},
                '$quantitySold',
                0
              ]
            }
          },
          totalRevenue: {
            $sum: {
              $cond: [{ $eq: ['$action', 'sale'] }, '$totalPrice', 0]
            }
          },
          totalCost: {
            $sum: {
              $cond: [{ $eq: ['$action', 'sale'] }, '$totalCost', 0]
            }
          },
          orderCount: { $sum: 1 }
        }
      }
    ]).toArray();

    if (aggregation.length > 0) {
      const stats = aggregation[0];
      const netSold = stats.totalSold - stats.totalRefunded;
      const totalProfit = stats.totalRevenue - stats.totalCost;

      const updateDoc = {
        bundleProductName: stats.productName,
        totalSold: stats.totalSold,
        totalRefunded: stats.totalRefunded,
        netSold: netSold,
        totalRevenue: stats.totalRevenue,
        totalCost: stats.totalCost,
        totalProfit: totalProfit,
        orderCount: stats.orderCount,
        lastUpdated: new Date(),
        updatedAt: new Date()
      };

      // 🔥 Only add fulfillment data for fruit bundles
      if (bundleSku.includes('GND-FRT')) {
        updateDoc.fulfilledSold = stats.fulfilledSold;
        updateDoc.unfulfilledSold = stats.unfulfilledSold;
        updateDoc.netUnfulfilled = stats.unfulfilledSold; // What gardeners need to pack
      }

      await dailySummary.updateOne(
        { 
          date: startOfDay,
          bundleSku: bundleSku
        },
        {
          $set: updateDoc,
          $setOnInsert: {
            createdAt: new Date()
          }
        },
        { upsert: true }
      );

      console.log(`📊 Updated bundle daily summary: ${bundleSku} - ${netSold} units, $${stats.totalRevenue.toFixed(2)} revenue`);
    }
  } catch (error) {
    console.error('❌ Error updating daily bundle summary:', error.message);
  }
}
// ============================================
// PRODUCT PRICING & COST CONFIGURATION
// ============================================

const COMPONENT_PRICING = {
  'MG-SML-FS-08J': { price: 13.99, cost: 2.59, weight: '8oz', name: 'Strawberry & Meyer Lemon Fruit Spread' },
  'MG-RTT-FS-08J': { price: 13.99, cost: 3.12, weight: '8oz', name: 'Raspberry & Tango Tangerine Fruit Spread' },
  'MG-PX-MM-08J': { price: 13.99, cost: 2.42, weight: '8oz', name: '"Sunrise" Pixie Tangerine Marmalade' },
  'MG-RVOA-FS-08J': { price: 13.99, cost: 2.60, weight: '8oz', name: 'Ruby Valencia & Apricot Fruit Spread' },
  'MG-CCH-MM-08J': { price: 13.99, cost: 2.66, weight: '8oz', name: 'Cara Cara & Hibiscus Marmalade' },
  'MG-MLH-MM-08J': { price: 13.99, cost: 2.82, weight: '8oz', name: 'Meyer Lemon & Honey Marmalade' },
  'MG-PX-MM-05J': { price: 9.00, cost: 1.93, weight: '5oz', name: '"Sunrise" Pixie Tangerine Marmalade' },
  'MG-MLH-MM-05J': { price: 9.00, cost: 1.93, weight: '5oz', name: 'Meyer Lemon & Honey Marmalade' },
  'MG-CCH-MM-05J': { price: 9.00, cost: 1.93, weight: '5oz', name: 'Cara Cara & Hibiscus Marmalade' },
  'MG-RVOA-FS-05J': { price: 9.00, cost: 2.14, weight: '4.5oz', name: 'Ruby Valencia & Apricot Fruit Spread' },
  'MG-OBA-FS-05J': { price: 9.00, cost: 2.07, weight: '4.5oz', name: 'Oroblanco & Agave Fruit Spread' },
  'MG-NCT-MM-05J': { price: 9.00, cost: 1.93, weight: '4.5oz', name: '"Tea Time" Navel Orange & Ceylon Tea Marmalade' },
  'MG-SML-FS-05J':{ price: 9.00, cost: 1.93, weight: '5oz', name: 'Strawberry & Meyer Lemon Fruit Spread' },
  'MG-RTT-FS-05J':{ price: 9.00, cost: 1.93, weight: '5oz', name: 'Raspberry & Tango Tangerine Fruit Spread' },
  'MG-GND-FRT-01LB': {
    price: 13.00,
    cost: 1.35,
    weight: '1LB',
    name: 'Golden Nugget Tangerines'
  }
};

// NEW: Bundle Pricing (actual bundle prices from Shopify)
const BUNDLE_PRICING = {
  'MG-SML-FS-08J-DTC-2PK': { price: 24.00, cost: 5.18, name: '2-Pack Strawberry & Meyer Lemon Fruit Spread' },
  'MG-RTT-FS-08J-DTC-2PK': { price: 24.00, cost: 6.25, name: '2-Pack Raspberry & Tango Tangerine Fruit Spread' },
  'MG-PX-MM-08J-DTC-2PK': { price: 24.00, cost: 4.84, name: '2-Pack "Sunrise" Pixie Tangerine Marmalade' },
  'MG-RVOA-FS-08J-DTC-2PK': { price: 24.00, cost: 5.37, name: '2-Pack Ruby Valencia & Apricot Fruit Spread' },
  'MG-CCH-MM-08J-DTC-2PK': { price: 24.00, cost: 5.32, name: '2-Pack Cara Cara & Hibiscus Marmalade' },
  'MG-MLH-MM-08J-DTC-2PK': { price: 24.00, cost: 5.64, name: '2-Pack Meyer Lemon & Honey Marmalade' },
  'MG-MIX-05J-DTC-6PK': { price: 70.00, cost: 11.79, name: '"Party Of Six" Gift Set' },
  '42720028917813': { price: 60.00, cost: 11.79, name: '"Amazon - Party Of Six" Gift Set' },
  'MG-GND-FRT-05LB': {
    price: 65.00,
    cost: 10.03,
    name: 'Golden Nugget Tangerines - 5LB Fruit Box'

  },
  'MG-GND-FRT-10LB': {
    price: 99.00,
    cost: 19.13,
    name: 'Golden Nugget Tangerines - 10LB Fruit Box'
  },
};

function getComponentPricing(sku) {
  if (COMPONENT_PRICING[sku]) {
    return COMPONENT_PRICING[sku];
  }

  console.warn(`⚠️  No pricing found for SKU: ${sku}, using defaults`);
  return {
    price: 0,
    cost: 0,
    weight: 'Unknown',
    name: sku
  };
}

function getBundlePricing(sku) {
  if (BUNDLE_PRICING[sku]) {
    return BUNDLE_PRICING[sku];
  }

  console.warn(`⚠️  No bundle pricing found for SKU: ${sku}`);
  return {
    price: 0,
    cost: 0,
    name: sku
  };
}

function isTrackableIndividual(sku) {
  return COMPONENT_PRICING.hasOwnProperty(sku);
}

// ============================================
// SHOPIFY CONFIGURATION
// ============================================

const SHOPIFY_CONFIG = {
  shop: process.env.SHOPIFY_SHOP_DOMAIN,
  accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
  apiVersion: '2024-01',
  webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET
};

const BUNDLE_CONFIG = {
  'MG-SML-FS-08J-DTC-2PK': [{ sku: 'MG-SML-FS-08J', quantity: 2 }],
  'MG-RTT-FS-08J-DTC-2PK': [{ sku: 'MG-RTT-FS-08J', quantity: 2 }],
  'MG-PX-MM-08J-DTC-2PK': [{ sku: 'MG-PX-MM-08J', quantity: 2 }],
  'MG-RVOA-FS-08J-DTC-2PK': [{ sku: 'MG-RVOA-FS-08J', quantity: 2 }],
  'MG-CCH-MM-08J-DTC-2PK': [{ sku: 'MG-CCH-MM-08J', quantity: 2 }],
  'MG-MLH-MM-08J-DTC-2PK': [{ sku: 'MG-MLH-MM-08J', quantity: 2 }],
  'MG-MIX-05J-DTC-6PK': [
    { sku: 'MG-PX-MM-05J', quantity: 1 },
    { sku: 'MG-MLH-MM-05J', quantity: 1 },
    { sku: 'MG-CCH-MM-05J', quantity: 1 },
    { sku: 'MG-RVOA-FS-05J', quantity: 1 },
    { sku: 'MG-SML-FS-05J', quantity: 1 },
    { sku: 'MG-RTT-FS-05J', quantity: 1 },
  ],
  '42720028917813': [
     { sku: 'MG-PX-MM-05J', quantity: 1 },
    { sku: 'MG-MLH-MM-05J', quantity: 1 },
    { sku: 'MG-CCH-MM-05J', quantity: 1 },
    { sku: 'MG-RVOA-FS-05J', quantity: 1 },
    { sku: 'MG-SML-FS-05J', quantity: 1 },
    { sku: 'MG-RTT-FS-05J', quantity: 1 },
  ],
  'MG-GND-FRT-05LB': [
    { sku: 'MG-GND-FRT-01LB', quantity: 5 },
  ],
  'MG-GND-FRT-10LB': [
    { sku: 'MG-GND-FRT-01LB', quantity: 10 },
  ],
};

function getAccessToken() {
  if (!SHOPIFY_CONFIG.accessToken) {
    throw new Error('SHOPIFY_ACCESS_TOKEN is not set in environment variables');
  }
  return SHOPIFY_CONFIG.accessToken;
}

async function shopifyGraphQL(query, variables = {}) {
  const accessToken = getAccessToken();

  try {
    const response = await axios.post(
      `https://${SHOPIFY_CONFIG.shop}/admin/api/${SHOPIFY_CONFIG.apiVersion}/graphql.json`,
      { query, variables },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken
        }
      }
    );

    if (response.data.errors) {
      console.error('GraphQL Errors:', response.data.errors);
      throw new Error('GraphQL query failed');
    }

    return response.data;
  } catch (error) {
    console.error('GraphQL Request Error:', error.response?.data || error.message);
    throw error;
  }
}

app.use((req, res, next) => {
  if (req.path.startsWith('/webhooks/')) {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      data += chunk;
    });
    req.on('end', () => {
      req.rawBody = data;
      try {
        req.body = JSON.parse(data);
      } catch (e) {
        req.body = {};
      }
      next();
    });
  } else {
    express.json()(req, res, next);
  }
});

const verifyWebhook = (req, res, next) => {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  const body = req.rawBody || JSON.stringify(req.body);

  const hash = crypto
    .createHmac('sha256', SHOPIFY_CONFIG.webhookSecret)
    .update(body, 'utf8')
    .digest('base64');

  if (hash === hmac) {
    next();
  } else {
    console.error('Webhook verification failed');
    res.status(401).send('Unauthorized');
  }
};

async function getVariantBySKU(sku) {
  const variantQuery = `
    query getVariantBySKU($query: String!) {
      productVariants(first: 1, query: $query) {
        edges {
          node {
            id
            sku
            inventoryQuantity
            inventoryItem {
              id
              inventoryLevels(first: 1) {
                edges {
                  node {
                    id
                    location {
                      id
                    }
                  }
                }
              }
            }
            displayName
            product {
              id
              title
              hasOnlyDefaultVariant
            }
          }
        }
      }
    }
  `;

  try {
    const response = await shopifyGraphQL(variantQuery, {
      query: `sku:${sku}`
    });

    const edges = response.data.productVariants.edges;
    if (edges.length > 0) {
      return edges[0].node;
    }

    const productQuery = `
      query getProductBySKU($query: String!) {
        products(first: 1, query: $query) {
          edges {
            node {
              id
              title
              hasOnlyDefaultVariant
              variants(first: 1) {
                edges {
                  node {
                    id
                    sku
                    inventoryQuantity
                    displayName
                    inventoryItem {
                      id
                      inventoryLevels(first: 1) {
                        edges {
                          node {
                            id
                            location {
                              id
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const productResponse = await shopifyGraphQL(productQuery, {
      query: `sku:${sku}`
    });

    const productEdges = productResponse.data.products.edges;
    if (productEdges.length > 0) {
      const product = productEdges[0].node;
      const variant = product.variants.edges[0]?.node;

      if (variant) {
        return {
          id: variant.id,
          sku: variant.sku,
          inventoryQuantity: variant.inventoryQuantity,
          displayName: product.hasOnlyDefaultVariant ? product.title : variant.displayName,
          inventoryItem: variant.inventoryItem,
          product: {
            id: product.id,
            title: product.title,
            hasOnlyDefaultVariant: product.hasOnlyDefaultVariant
          }
        };
      }
    }

    return null;
  } catch (error) {
    console.error(`Error fetching variant/product for SKU ${sku}:`, error);
    throw error;
  }
}

async function adjustInventory(sku, quantityDelta, reason = 'other') {
  try {
    console.log(`🔄 Adjusting inventory for SKU: ${sku}, Delta: ${quantityDelta}`);

    const variant = await getVariantBySKU(sku);

    if (!variant) {
      console.error(`❌ Variant not found for SKU: ${sku}`);
      return { success: false, error: 'Variant not found' };
    }

    const currentInventory = variant.inventoryQuantity || 0;
    const newInventory = Math.max(0, currentInventory + quantityDelta);

    console.log(`   Current: ${currentInventory}, New: ${newInventory} (${quantityDelta > 0 ? '+' : ''}${quantityDelta})`);

    const inventoryLevel = variant.inventoryItem?.inventoryLevels?.edges[0]?.node;

    if (!inventoryLevel) {
      console.error(`❌ No inventory level found for SKU: ${sku}`);
      return { success: false, error: 'No inventory level found' };
    }

    const inventoryItemId = variant.inventoryItem.id.split('/').pop();
    const locationId = inventoryLevel.location.id.split('/').pop();

    const accessToken = getAccessToken();

    const response = await axios.post(
      `https://${SHOPIFY_CONFIG.shop}/admin/api/${SHOPIFY_CONFIG.apiVersion}/inventory_levels/set.json`,
      {
        location_id: parseInt(locationId),
        inventory_item_id: parseInt(inventoryItemId),
        available: newInventory
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken
        }
      }
    );

    if (response.data && response.data.inventory_level) {
      console.log(`✅ Success: ${sku} inventory set to ${response.data.inventory_level.available}`);

      return {
        success: true,
        oldQuantity: currentInventory,
        newQuantity: response.data.inventory_level.available,
        sku: sku,
        delta: quantityDelta,
        productName: variant.displayName
      };
    }

    return {
      success: true,
      oldQuantity: currentInventory,
      newQuantity: newInventory,
      sku: sku,
      delta: quantityDelta,
      productName: variant.displayName
    };

  } catch (error) {
    console.error(`❌ Error adjusting inventory for ${sku}:`, error.message);
    return { success: false, error: error.message };
  }
}

async function saveDirectIndividualSale(item, orderData, action = 'sale') {
  const sku = item.sku;
  const quantity = item.quantity;

  if (!isTrackableIndividual(sku)) {
    console.log(`ℹ️  SKU ${sku} is not a trackable individual product, skipping`);
    return null;
  }

  console.log(`\n🛒 Processing direct sale: ${sku} (${quantity}x)`);

  const pricingInfo = getComponentPricing(sku);
  const variant = await getVariantBySKU(sku);

  // 🔥 USE ACTUAL PRICE FROM SHOPIFY, NOT HARDCODED
  const totalPrice = parseFloat(item.price) * quantity; // From Shopify order
  const unitPrice = parseFloat(item.price); // Actual price customer paid

  const unitCost = pricingInfo.cost; // Hardcoded cost
  const totalCost = unitCost * quantity;
  const profit = totalPrice - totalCost;

  try {
    const saleData = {
      componentSku: sku,
      componentProductName: variant?.displayName || pricingInfo.name || sku,
      quantitySold: quantity,
      weight: pricingInfo.weight,
      unitPrice: unitPrice, // Actual Shopify price
      unitCost: unitCost,   // Hardcoded cost
      totalPrice: totalPrice, // Actual revenue from Shopify
      totalCost: totalCost,
      profit: profit,
      saleType: 'direct',
      bundleSku: null,
      bundleProductName: null,
      orderId: orderData.id?.toString() || 'unknown',
      orderName: orderData.name || orderData.order_number || 'N/A',
      orderDate: orderData.created_at ? new Date(orderData.created_at) : new Date(),
      action: action,
      inventoryBefore: null,
      inventoryAfter: variant?.inventoryQuantity || null,
      processedAt: new Date()
    };

    await saveComponentSale(saleData);
    await updateDailyComponentSummary(sku, saleData.orderDate);

    return saleData;
  } catch (dbError) {
    console.error('❌ Failed to save direct sale to MongoDB:', dbError.message);
    return null;
  }
}

async function processLineItems(lineItems, action = 'reduce', orderData = {}) {
  const results = [];

  for (const item of lineItems) {
    const sku = item.sku;
    const quantity = item.quantity;

    if (!sku) {
      console.log(`⚠️  Skipping item without SKU: ${item.title || item.name}`);
      continue;
    }

    if (BUNDLE_CONFIG[sku]) {
      console.log(`\n📦 Processing bundle: ${sku} (${quantity}x)`);

      const bundleVariant = await getVariantBySKU(sku);
      const bundleProductName = bundleVariant?.displayName || item.title || sku;

      const bundlePricing = getBundlePricing(sku);
      const bundleComponents = BUNDLE_CONFIG[sku];

      // 🔥 USE ACTUAL PRICE FROM SHOPIFY
      const actualBundleUnitPrice = parseFloat(item.price); // What customer actually paid
      const actualBundleTotalPrice = actualBundleUnitPrice * quantity;
      const bundleUnitCost = bundlePricing.cost; // Hardcoded bundle cost
      const bundleTotalCost = bundleUnitCost * quantity;

      // Calculate total component value for proportional allocation
      const totalComponentValue = bundleComponents.reduce((sum, comp) => {
        const compPricing = getComponentPricing(comp.sku);
        return sum + (compPricing.price * comp.quantity);
      }, 0);

      try {
        const bundleSaleData = {
          bundleSku: sku,
          bundleProductName: bundleProductName,
          quantitySold: quantity,
          unitPrice: actualBundleUnitPrice, // Actual Shopify price
          totalPrice: actualBundleTotalPrice, // Actual revenue
          unitCost: bundleUnitCost, // Hardcoded bundle cost
          totalCost: bundleTotalCost,
          profit: actualBundleTotalPrice - bundleTotalCost,
          components: bundleComponents.map(comp => {
            const compPricing = getComponentPricing(comp.sku);
            return {
              sku: comp.sku,
              name: compPricing.name,
              quantity: comp.quantity
            };
          }),
          orderId: orderData.id?.toString() || 'unknown',
          orderName: orderData.name || orderData.order_number || 'N/A',
          orderDate: orderData.created_at ? new Date(orderData.created_at) : new Date(),
          action: action === 'reduce' ? 'sale' : action === 'restore' ? 'cancellation' : action,
          processedAt: new Date()
        };

        await saveBundleSale(bundleSaleData);
        await updateDailyBundleSummary(sku, bundleSaleData.orderDate);

      } catch (dbError) {
        console.error('❌ Failed to save bundle to MongoDB:', dbError.message);
      }

      // Process each component with ALLOCATED bundle pricing
      // In processLineItems() function, replace the component allocation section:

      // Process each component with ALLOCATED bundle pricing
      for (const component of bundleComponents) {
        const totalQuantity = component.quantity * quantity;
        const quantityDelta = action === 'reduce' ? -totalQuantity : totalQuantity;

        console.log(`   ${action === 'reduce' ? '➖' : '➕'} ${component.sku}: ${Math.abs(totalQuantity)}`);

        const result = await adjustInventory(
          component.sku,
          quantityDelta,
          action === 'reduce' ? 'sold' : 'returned'
        );

        const pricingInfo = getComponentPricing(component.sku);

        // 🔥 SPECIAL HANDLING for MG-MIX-05J-DTC-6PK (6-pack variety set)
        let allocatedBundleRevenue;
        let allocatedUnitPrice;
        let totalCost;
        let unitCost;
        let valueRatio;

        if (sku === 'MG-MIX-05J-DTC-6PK') {
          // Split revenue equally among 6 different items
          const itemsInSet = 6;
          allocatedBundleRevenue = (actualBundleTotalPrice / itemsInSet) * quantity;
          allocatedUnitPrice = allocatedBundleRevenue / totalQuantity;

          // Split cost equally among 6 different items
          const allocatedBundleCost = (bundleTotalCost / itemsInSet) * quantity;
          totalCost = allocatedBundleCost;
          unitCost = allocatedBundleCost / totalQuantity;

          valueRatio = 1 / itemsInSet; // Each item is 1/6th of the bundle

          console.log(`   💰 6-Pack split (1/6): Revenue $${allocatedBundleRevenue.toFixed(2)}, Cost $${allocatedBundleCost.toFixed(2)}`);
        }
        else {
          // Standard proportional allocation for all other bundles (2-packs, 5lb, 10lb)
          const componentIndividualValue = pricingInfo.price * component.quantity;
          valueRatio = componentIndividualValue / totalComponentValue;
          allocatedBundleRevenue = actualBundleTotalPrice * valueRatio;
          allocatedUnitPrice = allocatedBundleRevenue / totalQuantity;

          // Use individual component cost (not bundle cost)
          unitCost = pricingInfo.cost;
          totalCost = unitCost * totalQuantity;

          console.log(`   💰 Allocated revenue: $${allocatedBundleRevenue.toFixed(2)} (${(valueRatio * 100).toFixed(1)}% of $${actualBundleTotalPrice.toFixed(2)} bundle)`);
        }

        const profit = allocatedBundleRevenue - totalCost;

        try {
          const saleData = {
            componentSku: component.sku,
            componentProductName: result.productName || pricingInfo.name || component.sku,
            quantitySold: totalQuantity,
            weight: pricingInfo.weight,
            unitPrice: allocatedUnitPrice,  // Allocated from actual Shopify price
            unitCost: unitCost, // Either allocated bundle cost (6-pack) or individual cost (others)
            totalPrice: allocatedBundleRevenue, // Allocated revenue
            totalCost: totalCost,
            profit: profit,
            saleType: 'bundle',
            bundleSku: sku,
            bundleProductName: bundleProductName,
            bundleActualPrice: actualBundleUnitPrice,
            bundleAllocatedRevenue: allocatedBundleRevenue,
            bundleValueRatio: valueRatio,
            orderId: orderData.id?.toString() || 'unknown',
            orderName: orderData.name || orderData.order_number || 'N/A',
            orderDate: orderData.created_at ? new Date(orderData.created_at) : new Date(),
            action: action === 'reduce' ? 'sale' : action === 'restore' ? 'cancellation' : action,
            inventoryBefore: result.oldQuantity,
            inventoryAfter: result.newQuantity,
            processedAt: new Date()
          };

          await saveComponentSale(saleData);
          await updateDailyComponentSummary(component.sku, saleData.orderDate);

        } catch (dbError) {
          console.error('❌ Failed to save to MongoDB:', dbError.message);
        }

        results.push({
          type: 'bundle',
          bundleSku: sku,
          componentSku: component.sku,
          quantity: totalQuantity,
          allocatedRevenue: allocatedBundleRevenue,
          action,
          result
        });

        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    else if (isTrackableIndividual(sku)) {
      console.log(`\n🛒 Processing direct individual sale: ${sku} (${quantity}x)`);

      const actionType = action === 'reduce' ? 'sale' : action === 'restore' ? 'cancellation' : action;
      const saleData = await saveDirectIndividualSale(item, orderData, actionType);

      if (saleData) {
        results.push({
          type: 'direct',
          componentSku: sku,
          quantity: quantity,
          action: actionType,
          result: { success: true }
        });
      }
    }
    else {
      console.log(`ℹ️  SKU ${sku} is not a bundle or trackable individual, skipping`);
    }
  }

  return results;
}

// ============================================
// WEBHOOK ENDPOINTS
// ============================================

app.post('/webhooks/orders/create', verifyWebhook, async (req, res) => {
  console.log('\n📝 Order created webhook received');

  res.status(200).send('OK');

  try {
    const order = req.body;
    const lineItems = order.line_items;

    console.log(`Processing order ${order.name} with ${lineItems.length} items`);

    const results = await processLineItems(lineItems, 'reduce', order);

    console.log('✅ Order processing complete');
    if (results.length > 0) {
      console.table(results.map(r => ({
        Type: r.type || 'bundle',
        Bundle: r.bundleSku || 'N/A',
        Component: r.componentSku,
        Qty: r.quantity,
        Success: r.result.success ? '✅' : '❌'
      })));
    }
  } catch (error) {
    console.error('❌ Error processing order creation:', error);
  }
});

app.post('/webhooks/orders/cancelled', verifyWebhook, async (req, res) => {
  console.log('\n🚫 Order cancelled webhook received');

  res.status(200).send('OK');

  try {
    const order = req.body;
    const lineItems = order.line_items;

    console.log(`Processing cancellation for order ${order.name}`);

    const results = await processLineItems(lineItems, 'restore', order);

    console.log('✅ Order cancellation processing complete');
  } catch (error) {
    console.error('❌ Error processing order cancellation:', error);
  }
});

app.post('/webhooks/orders/edited', verifyWebhook, async (req, res) => {
  console.log('\n✏️ Order edited webhook received');

  res.status(200).send('OK');

  try {
    const orderEdit = req.body;

    if (orderEdit.line_items_removed && orderEdit.line_items_removed.length > 0) {
      console.log('Processing removed items...');
      await processLineItems(orderEdit.line_items_removed, 'restore', orderEdit);
    }

    if (orderEdit.line_items_added && orderEdit.line_items_added.length > 0) {
      console.log('Processing added items...');
      await processLineItems(orderEdit.line_items_added, 'reduce', orderEdit);
    }

    console.log('✅ Order edit processing complete');
  } catch (error) {
    console.error('❌ Error processing order edit:', error);
  }
});

// ============================================
// API ENDPOINTS
// ============================================

// Component sales summary
// backend/routes/componentSales.js

app.get('/api/component-sales/summary', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: 'startDate and endDate are required'
      });
    }

    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);

    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    const componentSales = db.collection('componentSales');

    // Aggregate component sales with fulfillment tracking
    const components = await componentSales.aggregate([
      {
        $match: {
          orderDate: { $gte: start, $lte: end },
          action: 'sale'
        }
      },
      {
        $group: {
          _id: '$componentSku',
          productName: { $first: '$componentProductName' },
          weight: { $first: '$weight' },
          quantitySold: { $sum: '$quantitySold' },
          // Sum fulfilled quantities (only for items with isFulfilled field)
          fulfilledSold: {
            $sum: {
              $cond: [
                { $eq: ['$isFulfilled', true] },
                '$quantitySold',
                0
              ]
            }
          },
          // Sum unfulfilled quantities (only for items with isFulfilled field)
          unfulfilledSold: {
            $sum: {
              $cond: [
                { $eq: ['$isFulfilled', false] },
                '$quantitySold',
                0
              ]
            }
          },
          directSales: {
            $sum: {
              $cond: [{ $eq: ['$saleType', 'direct'] }, '$quantitySold', 0]
            }
          },
          bundleSales: {
            $sum: {
              $cond: [{ $eq: ['$saleType', 'bundle'] }, '$quantitySold', 0]
            }
          },
          totalRevenue: { $sum: '$totalPrice' },
          totalCost: { $sum: '$totalCost' },
          totalProfit: { $sum: '$profit' }
        }
      },
      {
        $project: {
          componentSku: '$_id',
          productName: 1,
          weight: 1,
          quantitySold: 1,
          fulfilledSold: 1,
          unfulfilledSold: 1,
          directSales: 1,
          bundleSales: 1,
          totalRevenue: { $round: ['$totalRevenue', 2] },
          totalCost: { $round: ['$totalCost', 2] },
          totalProfit: { $round: ['$totalProfit', 2] },
          avgProfitPerUnit: {
            $round: [
              { $divide: ['$totalProfit', '$quantitySold'] },
              2
            ]
          },
          _id: 0
        }
      },
      {
        $sort: { totalRevenue: -1 }
      }
    ]).toArray();

    // Calculate totals
    const totals = components.reduce((acc, item) => {
      acc.totalUnits += item.quantitySold;
      acc.directSales += item.directSales;
      acc.bundleSales += item.bundleSales;
      acc.totalRevenue += item.totalRevenue;
      acc.totalCost += item.totalCost;
      acc.totalProfit += item.totalProfit;
      return acc;
    }, {
      totalUnits: 0,
      directSales: 0,
      bundleSales: 0,
      totalRevenue: 0,
      totalCost: 0,
      totalProfit: 0
    });

    totals.profitMargin = totals.totalRevenue > 0
      ? ((totals.totalProfit / totals.totalRevenue) * 100).toFixed(2)
      : 0;

    res.json({
      success: true,
      summary: {
        components,
        totals,
        dateRange: {
          start: start.toISOString(),
          end: end.toISOString()
        }
      }
    });

  } catch (error) {
    console.error('Error fetching component sales summary:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch component sales summary',
      error: error.message
    });
  }
});

// Bundle sales summary
app.get('/api/bundle-sales/summary', async (req, res) => {
  try {
    const db = await connectDB();
    const bundleSales = db.collection('bundleSales');

    const {
      days = 7,
      startDate,
      endDate
    } = req.query;

    let dateQuery = {};
    if (startDate && endDate) {
      dateQuery = {
        orderDate: {
          $gte: new Date(startDate),
          $lte: new Date(endDate)
        }
      };
    } else {
      const daysAgo = new Date();
      daysAgo.setDate(daysAgo.getDate() - parseInt(days));
      dateQuery = {
        orderDate: { $gte: daysAgo }
      };
    }

    const summary = await bundleSales.aggregate([
      {
        $match: {
          ...dateQuery,
          action: 'sale'
        }
      },
      {
        $group: {
          _id: '$bundleSku',
          productName: { $first: '$bundleProductName' },
          unitPrice: { $first: '$unitPrice' },
          totalQuantitySold: { $sum: '$quantitySold' },
          totalRevenue: { $sum: '$totalPrice' },
          orderCount: { $addToSet: '$orderId' },
          components: { $first: '$components' }
        }
      },
      {
        $project: {
          _id: 0,
          bundleSku: '$_id',
          bundleName: '$productName',
          unitPrice: 1,
          quantitySold: '$totalQuantitySold',
          totalRevenue: { $round: ['$totalRevenue', 2] },
          orderCount: { $size: '$orderCount' },
          components: 1
        }
      },
      { $sort: { quantitySold: -1 } }
    ]).toArray();

    const grandTotals = summary.reduce((acc, item) => {
      acc.totalBundles += item.quantitySold;
      acc.totalRevenue += item.totalRevenue;
      return acc;
    }, { totalBundles: 0, totalRevenue: 0 });

    res.json({
      success: true,
      period: {
        days: parseInt(days),
        startDate: dateQuery.orderDate?.$gte,
        endDate: dateQuery.orderDate?.$lte || new Date()
      },
      summary: {
        bundles: summary,
        totals: {
          totalBundles: grandTotals.totalBundles,
          totalRevenue: Math.round(grandTotals.totalRevenue * 100) / 100
        }
      }
    });

  } catch (error) {
    console.error('Error fetching bundle sales summary:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get specific component details
app.get('/api/component-sales/:sku', async (req, res) => {
  try {
    const db = await connectDB();
    const componentSales = db.collection('componentSales');

    const { sku } = req.params;
    const { days = 7 } = req.query;

    const daysAgo = new Date();
    daysAgo.setDate(daysAgo.getDate() - parseInt(days));

    const sales = await componentSales.find({
      componentSku: sku,
      orderDate: { $gte: daysAgo }
    })
      .sort({ orderDate: -1 })
      .limit(100)
      .toArray();

    const summary = await componentSales.aggregate([
      {
        $match: {
          componentSku: sku,
          orderDate: { $gte: daysAgo }
        }
      },
      {
        $group: {
          _id: null,
          productName: { $first: '$componentProductName' },
          weight: { $first: '$weight' },
          unitPrice: { $first: '$unitPrice' },
          unitCost: { $first: '$unitCost' },
          totalSold: {
            $sum: {
              $cond: [{ $eq: ['$action', 'sale'] }, '$quantitySold', 0]
            }
          },
          totalRefunded: {
            $sum: {
              $cond: [{ $in: ['$action', ['refund', 'cancellation']] }, '$quantitySold', 0]
            }
          },
          directSales: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$action', 'sale'] },
                    { $eq: ['$saleType', 'direct'] }
                  ]
                },
                '$quantitySold',
                0
              ]
            }
          },
          bundleSales: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$action', 'sale'] },
                    { $eq: ['$saleType', 'bundle'] }
                  ]
                },
                '$quantitySold',
                0
              ]
            }
          },
          totalRevenue: { $sum: '$totalPrice' },
          totalCost: { $sum: '$totalCost' },
          totalProfit: { $sum: '$profit' },
          orderCount: { $addToSet: '$orderId' }
        }
      }
    ]).toArray();

    const stats = summary[0] || {
      totalSold: 0,
      totalRefunded: 0,
      directSales: 0,
      bundleSales: 0,
      totalRevenue: 0,
      totalCost: 0,
      totalProfit: 0,
      orderCount: []
    };

    res.json({
      success: true,
      componentSku: sku,
      productName: stats.productName || sku,
      weight: stats.weight,
      pricing: {
        unitPrice: stats.unitPrice,
        unitCost: stats.unitCost,
        profitPerUnit: stats.unitPrice && stats.unitCost
          ? Math.round((stats.unitPrice - stats.unitCost) * 100) / 100
          : 0
      },
      period: { days: parseInt(days) },
      summary: {
        totalSold: stats.totalSold,
        totalRefunded: stats.totalRefunded,
        netSold: stats.totalSold - stats.totalRefunded,
        directSales: stats.directSales,
        bundleSales: stats.bundleSales,
        totalRevenue: Math.round(stats.totalRevenue * 100) / 100,
        totalCost: Math.round(stats.totalCost * 100) / 100,
        totalProfit: Math.round(stats.totalProfit * 100) / 100,
        orderCount: stats.orderCount.length
      },
      recentSales: sales
    });

  } catch (error) {
    console.error('Error fetching component details:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get specific bundle details
app.get('/api/bundle-sales/:sku', async (req, res) => {
  try {
    const db = await connectDB();
    const bundleSales = db.collection('bundleSales');

    const { sku } = req.params;
    const { days = 7 } = req.query;

    const daysAgo = new Date();
    daysAgo.setDate(daysAgo.getDate() - parseInt(days));

    const sales = await bundleSales.find({
      bundleSku: sku,
      orderDate: { $gte: daysAgo }
    })
      .sort({ orderDate: -1 })
      .limit(100)
      .toArray();

    const summary = await bundleSales.aggregate([
      {
        $match: {
          bundleSku: sku,
          orderDate: { $gte: daysAgo }
        }
      },
      {
        $group: {
          _id: null,
          productName: { $first: '$bundleProductName' },
          unitPrice: { $first: '$unitPrice' },
          components: { $first: '$components' },
          totalSold: {
            $sum: {
              $cond: [{ $eq: ['$action', 'sale'] }, '$quantitySold', 0]
            }
          },
          totalRefunded: {
            $sum: {
              $cond: [{ $in: ['$action', ['refund', 'cancellation']] }, '$quantitySold', 0]
            }
          },
          totalRevenue: {
            $sum: {
              $cond: [{ $eq: ['$action', 'sale'] }, '$totalPrice', 0]
            }
          },
          orderCount: { $addToSet: '$orderId' }
        }
      }
    ]).toArray();

    const stats = summary[0] || {
      totalSold: 0,
      totalRefunded: 0,
      totalRevenue: 0,
      orderCount: [],
      components: []
    };

    res.json({
      success: true,
      bundleSku: sku,
      bundleName: stats.productName || sku,
      unitPrice: stats.unitPrice,
      components: stats.components,
      period: { days: parseInt(days) },
      summary: {
        totalSold: stats.totalSold,
        totalRefunded: stats.totalRefunded,
        netSold: stats.totalSold - stats.totalRefunded,
        totalRevenue: Math.round(stats.totalRevenue * 100) / 100,
        orderCount: stats.orderCount.length
      },
      recentSales: sales
    });

  } catch (error) {
    console.error('Error fetching bundle details:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Daily component breakdown
app.get('/api/component-sales/daily', async (req, res) => {
  try {
    const db = await connectDB();
    const dailySummary = db.collection('dailyComponentSummary');

    const { days = 7, sku } = req.query;

    const daysAgo = new Date();
    daysAgo.setDate(daysAgo.getDate() - parseInt(days));
    daysAgo.setHours(0, 0, 0, 0);

    let query = { date: { $gte: daysAgo } };
    if (sku) {
      query.componentSku = sku;
    }

    const dailyData = await dailySummary.find(query)
      .sort({ date: -1, netSold: -1 })
      .limit(1000)
      .toArray();

    res.json({
      success: true,
      period: { days: parseInt(days) },
      dailyBreakdown: dailyData
    });

  } catch (error) {
    console.error('Error fetching daily data:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Daily bundle breakdown
app.get('/api/bundle-sales/daily', async (req, res) => {
  try {
    const db = await connectDB();
    const dailySummary = db.collection('dailyBundleSummary');

    const { days = 7, sku } = req.query;

    const daysAgo = new Date();
    daysAgo.setDate(daysAgo.getDate() - parseInt(days));
    daysAgo.setHours(0, 0, 0, 0);

    let query = { date: { $gte: daysAgo } };
    if (sku) {
      query.bundleSku = sku;
    }

    const dailyData = await dailySummary.find(query)
      .sort({ date: -1, netSold: -1 })
      .limit(1000)
      .toArray();

    res.json({
      success: true,
      period: { days: parseInt(days) },
      dailyBreakdown: dailyData
    });

  } catch (error) {
    console.error('Error fetching bundle daily data:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// HEALTH & TEST ENDPOINTS
// ============================================

app.get('/health', async (req, res) => {
  const dbConnected = db !== null;
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    mongoConnected: dbConnected
  });
});

app.get('/test/variant/:sku', async (req, res) => {
  try {
    const variant = await getVariantBySKU(req.params.sku);
    res.json(variant);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// FULFILLMENT WEBHOOK
// ============================================

app.post('/webhooks/fulfillments/create', verifyWebhook, async (req, res) => {
  console.log('\n📦 Fulfillment created webhook received');
  
  res.status(200).send('OK');
  
  try {
    const fulfillment = req.body;
    const orderId = fulfillment.order_id?.toString();
    
    if (!orderId) {
      console.log('⚠️  No order ID in fulfillment webhook');
      return;
    }

    console.log(`Processing fulfillment for order #${orderId}`);
    
    const db = await connectDB();
    const componentSales = db.collection('componentSales');
    const bundleSales = db.collection('bundleSales');
    
    // Get all line items from this fulfillment
    const lineItems = fulfillment.line_items || [];
    
    for (const item of lineItems) {
      const sku = item.sku;
      
      if (!sku) continue;
      
      // Only update fruit products
      if (!sku.includes('GND-FRT')) {
        console.log(`   ℹ️  Skipping non-fruit item: ${sku}`);
        continue;
      }
      
      const quantity = item.quantity;
      
      console.log(`   📦 Marking ${quantity}x ${sku} as fulfilled in order ${orderId}`);
      
      // Update component sales
      const componentResult = await componentSales.updateMany(
        {
          orderId: orderId,
          componentSku: sku,
          isFulfilled: false // Only update unfulfilled items
        },
        {
          $set: {
            isFulfilled: true,
            fulfillmentStatus: 'fulfilled',
            fulfilledAt: new Date(),
            updatedAt: new Date()
          }
        }
      );
      
      console.log(`   ✅ Updated ${componentResult.modifiedCount} component sale records`);
      
      // Update bundle sales if this is a bundle
      const bundleResult = await bundleSales.updateMany(
        {
          orderId: orderId,
          bundleSku: sku,
          isFulfilled: false
        },
        {
          $set: {
            isFulfilled: true,
            fulfillmentStatus: 'fulfilled',
            fulfilledAt: new Date(),
            updatedAt: new Date()
          }
        }
      );
      
      if (bundleResult.modifiedCount > 0) {
        console.log(`   ✅ Updated ${bundleResult.modifiedCount} bundle sale records`);
      }
      
      // Rebuild daily summaries for the order date
      // Find the order date from one of the sales records
      const sampleSale = await componentSales.findOne({
        orderId: orderId,
        componentSku: sku
      });
      
      if (sampleSale) {
        await updateDailyComponentSummary(sku, sampleSale.orderDate);
        console.log(`   📊 Updated daily summary for ${sku}`);
      }
    }
    
    console.log('✅ Fulfillment processing complete');
    
  } catch (error) {
    console.error('❌ Error processing fulfillment:', error);
  }
});

app.post('/test/process-order', express.json(), async (req, res) => {
  const { lineItems, action } = req.body;

  try {
    const mockOrder = {
      id: 'test-' + Date.now(),
      name: '#TEST' + Math.floor(Math.random() * 1000),
      created_at: new Date().toISOString()
    };

    const results = await processLineItems(lineItems, action || 'reduce', mockOrder);
    res.json({ success: true, results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  if (mongoClient) {
    await mongoClient.close();
    console.log('✅ MongoDB connection closed');
  }
  process.exit(0);
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║  Sales Tracker - Components & Bundles                  ║
║  Server running on port ${PORT}                           ║
║                                                        ║
║  Tracks: Individual Components + Bundles              ║
║                                                        ║
║  MongoDB: ${db ? '✅ Connected'.padEnd(40) : '❌ Disconnected'.padEnd(40)} ║
║                                                        ║
║  Component APIs:                                       ║
║  GET /api/component-sales/summary                      ║
║  GET /api/component-sales/:sku                         ║
║  GET /api/component-sales/daily                        ║
║                                                        ║
║  Bundle APIs:                                          ║
║  GET /api/bundle-sales/summary                         ║
║  GET /api/bundle-sales/:sku                            ║
║  GET /api/bundle-sales/daily                           ║
╚════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;