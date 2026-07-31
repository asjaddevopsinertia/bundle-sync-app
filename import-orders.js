// reset-and-import.js
require('dotenv').config();
process.env.TZ = 'America/Los_Angeles';
const { MongoClient } = require('mongodb');
const axios = require('axios');

// ============================================
// CONFIGURATION
// ============================================

const SHOPIFY_CONFIG = {
  shop: process.env.SHOPIFY_SHOP_DOMAIN,
  accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
  apiVersion: '2024-01'
};

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || 'shopify-bundles';

// ============================================
// SKU MAPPING (Old SKU → New SKU)
// ============================================

const SKU_MAPPING = {
    '45203166462005':'MG-SML-FS-08J',
    '45203137232949':'MG-RTT-FS-08J',
    '44984624283701':'MG-PX-MM-08J',
    '44984622710837':'MG-RVOA-FS-08J',
    '44984622415925':'MG-CCH-MM-08J',
    '41570524790837':'MG-MLH-MM-08J',
    '44984626675765':'MG-PX-MM-08J-DTC-2PK',
    '44984627953717':'MG-RVOA-FS-08J-DTC-2PK',
    '44984628314165':'MG-CCH-MM-08J-DTC-2PK',
    '45203166494773':'MG-SML-FS-08J-DTC-2PK',
    '44980538015797':'MG-MLH-MM-08J-DTC-2PK',
    '45203137265717':'MG-RTT-FS-08J-DTC-2PK',
    '42720028917813':'MG-MIX-05J-DTC-6PK',
    '42393335595061':'MG-GND-FRT-05LB',
    '42952348565557':'MG-GND-FRT-10LB'
} 

// ============================================
// PRODUCT PRICING & COST
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
  'MG-GND-FRT-01LB': { price: 13.00, cost: 1.35, weight: '1LB', name: 'Golden Nugget Tangerines' }
};

// Bundle Costs - actual cost to produce the bundle
const BUNDLE_PRICING = {
  'MG-SML-FS-08J-DTC-2PK': { price: 24.00, cost: 5.18, name: '2-Pack Strawberry & Meyer Lemon Fruit Spread' },
  'MG-RTT-FS-08J-DTC-2PK': { price: 24.00, cost: 6.25, name: '2-Pack Raspberry & Tango Tangerine Fruit Spread' },
  'MG-PX-MM-08J-DTC-2PK': { price: 24.00, cost: 4.84, name: '2-Pack "Sunrise" Pixie Tangerine Marmalade' },
  'MG-RVOA-FS-08J-DTC-2PK': { price: 24.00, cost: 5.37, name: '2-Pack Ruby Valencia & Apricot Fruit Spread' },
  'MG-CCH-MM-08J-DTC-2PK': { price: 24.00, cost: 5.32, name: '2-Pack Cara Cara & Hibiscus Marmalade' },
  'MG-MLH-MM-08J-DTC-2PK': { price: 24.00, cost: 5.64, name: '2-Pack Meyer Lemon & Honey Marmalade' },
  'MG-MIX-05J-DTC-6PK': { price: 60.00, cost: 11.79, name: '"Party Of Six" Gift Set' },
  'MG-GND-FRT-05LB': { price: 65.00, cost: 10.03, name: 'Golden Nugget Tangerines - 5LB Fruit Box' },
  'MG-GND-FRT-10LB': { price: 99.00, cost: 19.13, name: 'Golden Nugget Tangerines - 10LB Fruit Box' },
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
    { sku: 'MG-OBA-FS-05J', quantity: 1 },
    { sku: 'MG-NCT-MM-05J', quantity: 1 },
  ],
  'MG-GND-FRT-05LB': [
    { sku: 'MG-GND-FRT-01LB', quantity: 5 },
  ],
  'MG-GND-FRT-10LB': [
    { sku: 'MG-GND-FRT-01LB', quantity: 10 },
  ],
};

// ============================================
// HELPER FUNCTIONS
// ============================================

function mapSKU(oldSKU) {
  return SKU_MAPPING[oldSKU] || oldSKU;
}

function getComponentPricing(sku) {
  if (COMPONENT_PRICING[sku]) {
    return COMPONENT_PRICING[sku];
  }
  console.warn(`⚠️  No pricing found for SKU: ${sku}`);
  return { price: 0, cost: 0, weight: 'Unknown', name: sku };
}

function getBundlePricing(sku) {
  if (BUNDLE_PRICING[sku]) {
    return BUNDLE_PRICING[sku];
  }
  console.warn(`⚠️  No bundle pricing found for SKU: ${sku}`);
  return { price: 0, cost: 0, name: sku };
}

function isTrackableIndividual(sku) {
  return COMPONENT_PRICING.hasOwnProperty(sku);
}

function isBundle(sku) {
  return BUNDLE_CONFIG.hasOwnProperty(sku);
}

// Check if SKU is a fruit product that needs fulfillment tracking
function isFruitProduct(sku) {
  return sku.includes('GND-FRT'); // Golden Nugget Fruit products
}

// ============================================
// SHOPIFY API
// ============================================

async function shopifyRestAPI(endpoint, params = {}) {
  try {
    const url = `https://${SHOPIFY_CONFIG.shop}/admin/api/${SHOPIFY_CONFIG.apiVersion}/${endpoint}`;
    const response = await axios.get(url, {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_CONFIG.accessToken,
        'Content-Type': 'application/json'
      },
      params
    });
    
    return response.data;
  } catch (error) {
    console.error('Shopify API Error:', error.response?.data || error.message);
    throw error;
  }
}

async function fetchAllOrders(startDate, endDate) {
  console.log(`\n📥 Fetching orders from Shopify...`);
  console.log(`   From: ${startDate}`);
  console.log(`   To:   ${endDate}`);
  
  let allOrders = [];
  let params = {
    status: 'any',
    created_at_min: startDate,
    created_at_max: endDate,
    limit: 250
  };

  let hasMore = true;
  let pageCount = 0;

  while (hasMore) {
    pageCount++;
    console.log(`   Fetching page ${pageCount}...`);
    
    try {
      const url = `https://${SHOPIFY_CONFIG.shop}/admin/api/${SHOPIFY_CONFIG.apiVersion}/orders.json`;
      const response = await axios.get(url, {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_CONFIG.accessToken
        },
        params
      });

      const orders = response.data.orders || [];
      allOrders = allOrders.concat(orders);
      console.log(`   Got ${orders.length} orders (total: ${allOrders.length})`);

      // Check for next page using Link header
      const linkHeader = response.headers.link;
      
      if (linkHeader && linkHeader.includes('rel="next"')) {
        const matches = linkHeader.match(/<[^>]*[?&]page_info=([^>&]+)[^>]*>;\s*rel="next"/);
        
        if (matches && matches[1]) {
          params = {
            limit: 250,
            page_info: matches[1]
          };
        } else {
          hasMore = false;
        }
      } else {
        hasMore = false;
      }

      // Rate limiting - be nice to Shopify API
      await new Promise(resolve => setTimeout(resolve, 500));
      
    } catch (error) {
      console.error('Error fetching orders:', error.response?.data || error.message);
      throw error;
    }
  }

  console.log(`✅ Fetched ${allOrders.length} total orders\n`);
  
  if (allOrders.length > 0) {
    const dates = allOrders.map(o => new Date(o.created_at));
    const oldest = new Date(Math.min(...dates));
    const newest = new Date(Math.max(...dates));
    console.log(`   Oldest order: ${oldest.toLocaleDateString()}`);
    console.log(`   Newest order: ${newest.toLocaleDateString()}\n`);
  }
  
  return allOrders;
}

// ============================================
// DATA PROCESSING
// ============================================

async function processHistoricalOrder(order, db) {
  const componentSales = db.collection('componentSales');
  const bundleSales = db.collection('bundleSales');
  
  const orderDate = new Date(order.created_at);
  const isCancelled = order.cancelled_at !== null;
  const financialStatus = order.financial_status;
  const fulfillmentStatus = order.fulfillment_status;
  
  // Skip if order is cancelled or not paid
  if (isCancelled || financialStatus === 'voided') {
    return { skipped: true, reason: 'cancelled' };
  }

  // Only process paid or partially_refunded orders
  if (!['paid', 'partially_refunded', 'refunded'].includes(financialStatus)) {
    return { skipped: true, reason: 'unpaid' };
  }

  let processedItems = 0;
  let skippedItems = 0;

  for (const item of order.line_items) {
    let originalSKU = item.sku;
    if (!originalSKU) {
      skippedItems++;
      continue;
    }

    // Map old SKU to new SKU
    const currentSKU = mapSKU(originalSKU);
    const quantity = item.quantity;

    // 🔥 GET ACTUAL PRICE FROM SHOPIFY
    const actualUnitPrice = parseFloat(item.price) || 0;
    const actualTotalPrice = actualUnitPrice * quantity;

    // Determine fulfillment status
    const isFulfilled = fulfillmentStatus === 'fulfilled' || 
                       (item.fulfillment_status === 'fulfilled');

    // Process as bundle
    if (isBundle(currentSKU)) {
      const bundlePricing = getBundlePricing(currentSKU);
      const bundleComponents = BUNDLE_CONFIG[currentSKU];
      
      // Bundle cost (hardcoded)
      const bundleUnitCost = bundlePricing.cost;
      const bundleTotalCost = bundleUnitCost * quantity;
      const bundleProfit = actualTotalPrice - bundleTotalCost;
      
      const containsFruit = isFruitProduct(currentSKU);
      
      // Save bundle sale with ACTUAL Shopify price
      const bundleSaleData = {
        bundleSku: currentSKU,
        bundleProductName: item.name,
        quantitySold: quantity,
        unitPrice: actualUnitPrice, // 🔥 ACTUAL price from Shopify
        totalPrice: actualTotalPrice, // 🔥 ACTUAL revenue
        unitCost: bundleUnitCost, // Hardcoded cost
        totalCost: bundleTotalCost,
        profit: bundleProfit,
        components: bundleComponents.map(comp => {
          const compPricing = getComponentPricing(comp.sku);
          return {
            sku: comp.sku,
            name: compPricing.name,
            quantity: comp.quantity
          };
        }),
        orderId: order.id.toString(),
        orderName: order.name,
        orderDate: orderDate,
        action: 'sale',
        processedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        importedData: true,
        originalSKU: originalSKU !== currentSKU ? originalSKU : undefined
      };

      if (containsFruit) {
        bundleSaleData.fulfillmentStatus = fulfillmentStatus;
        bundleSaleData.isFulfilled = isFulfilled;
      }

      await bundleSales.insertOne(bundleSaleData);

      // Calculate total component value for proportional allocation (for non-6pack bundles)
      const totalComponentValue = bundleComponents.reduce((sum, comp) => {
        const compPricing = getComponentPricing(comp.sku);
        return sum + (compPricing.price * comp.quantity);
      }, 0);

      // Save component sales - allocate ACTUAL bundle revenue
      for (const component of bundleComponents) {
        const totalQuantity = component.quantity * quantity;
        const pricingInfo = getComponentPricing(component.sku);
        
        // 🔥 SPECIAL HANDLING for MG-MIX-05J-DTC-6PK (6-pack variety set)
        let allocatedRevenue;
        let allocatedUnitPrice;
        let totalCost;
        let unitCost;
        let valueRatio;
        
        if (currentSKU === 'MG-MIX-05J-DTC-6PK') {
          // Split revenue equally among 6 different items
          const itemsInSet = 6;
          allocatedRevenue = (actualTotalPrice / itemsInSet) * quantity;
          allocatedUnitPrice = allocatedRevenue / totalQuantity;
          
          // Split cost equally among 6 different items
          const allocatedBundleCost = (bundleTotalCost / itemsInSet) * quantity;
          totalCost = allocatedBundleCost;
          unitCost = allocatedBundleCost / totalQuantity;
          
          valueRatio = 1 / itemsInSet; // Each item is 1/6th of the bundle
        } else {
          // Standard proportional allocation for other bundles
          const componentIndividualValue = pricingInfo.price * component.quantity;
          valueRatio = componentIndividualValue / totalComponentValue;
          allocatedRevenue = actualTotalPrice * valueRatio;
          allocatedUnitPrice = allocatedRevenue / totalQuantity;
          
          // Use individual component cost (not bundle cost)
          unitCost = pricingInfo.cost;
          totalCost = unitCost * totalQuantity;
        }
        
        const profit = allocatedRevenue - totalCost;

        const componentSaleData = {
          componentSku: component.sku,
          componentProductName: pricingInfo.name,
          quantitySold: totalQuantity,
          weight: pricingInfo.weight,
          unitPrice: allocatedUnitPrice, // 🔥 Allocated from ACTUAL Shopify price
          unitCost: unitCost, // Either allocated (6-pack) or individual cost
          totalPrice: allocatedRevenue, // 🔥 Allocated revenue
          totalCost: totalCost,
          profit: profit,
          saleType: 'bundle',
          bundleSku: currentSKU,
          bundleProductName: item.name,
          bundleActualPrice: actualUnitPrice, // Track actual bundle price
          bundleAllocatedRevenue: allocatedRevenue,
          bundleValueRatio: valueRatio,
          orderId: order.id.toString(),
          orderName: order.name,
          orderDate: orderDate,
          action: 'sale',
          inventoryBefore: null,
          inventoryAfter: null,
          processedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
          importedData: true,
          originalSKU: originalSKU !== currentSKU ? originalSKU : undefined
        };

        if (isFruitProduct(component.sku)) {
          componentSaleData.fulfillmentStatus = fulfillmentStatus;
          componentSaleData.isFulfilled = isFulfilled;
        }

        await componentSales.insertOne(componentSaleData);
      }
      
      processedItems++;
    }
    // Process as individual component
    else if (isTrackableIndividual(currentSKU)) {
      const pricingInfo = getComponentPricing(currentSKU);
      
      // 🔥 USE ACTUAL price from Shopify, hardcoded cost
      const unitCost = pricingInfo.cost;
      const totalCost = unitCost * quantity;
      const profit = actualTotalPrice - totalCost;

      const componentSaleData = {
        componentSku: currentSKU,
        componentProductName: item.name,
        quantitySold: quantity,
        weight: pricingInfo.weight,
        unitPrice: actualUnitPrice, // 🔥 ACTUAL Shopify price
        unitCost: unitCost, // Hardcoded cost
        totalPrice: actualTotalPrice, // 🔥 ACTUAL revenue
        totalCost: totalCost,
        profit: profit,
        saleType: 'direct',
        bundleSku: null,
        bundleProductName: null,
        orderId: order.id.toString(),
        orderName: order.name,
        orderDate: orderDate,
        action: 'sale',
        inventoryBefore: null,
        inventoryAfter: null,
        processedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        importedData: true,
        originalSKU: originalSKU !== currentSKU ? originalSKU : undefined
      };

      if (isFruitProduct(currentSKU)) {
        componentSaleData.fulfillmentStatus = fulfillmentStatus;
        componentSaleData.isFulfilled = isFulfilled;
      }

      await componentSales.insertOne(componentSaleData);
      processedItems++;
    }
    else {
      skippedItems++;
    }
  }

  return { processed: processedItems, skipped: skippedItems };
}

// ============================================
// DAILY SUMMARY REBUILD
// ============================================

async function rebuildDailySummaries(db, startDate, endDate) {
  console.log('\n📊 Building daily summaries...');
  
  const componentSales = db.collection('componentSales');
  const bundleSales = db.collection('bundleSales');
  const dailyComponentSummary = db.collection('dailyComponentSummary');
  const dailyBundleSummary = db.collection('dailyBundleSummary');

  // Get all unique dates in the range
  const dates = [];
  const currentDate = new Date(startDate);
  const end = new Date(endDate);
  
  while (currentDate <= end) {
    dates.push(new Date(currentDate));
    currentDate.setDate(currentDate.getDate() + 1);
  }

  console.log(`   Processing ${dates.length} days...`);

  for (const date of dates) {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    // Component summaries
    const componentAgg = await componentSales.aggregate([
      {
        $match: {
          orderDate: { $gte: startOfDay, $lte: endOfDay },
          action: 'sale'
        }
      },
      {
        $group: {
          _id: '$componentSku',
          productName: { $first: '$componentProductName' },
          weight: { $first: '$weight' },
          totalSold: { $sum: '$quantitySold' },
          fulfilledSold: {
            $sum: {
              $cond: [
                { $and: [
                  { $eq: ['$isFulfilled', true] },
                  { $ne: ['$isFulfilled', null] }
                ]},
                '$quantitySold',
                0
              ]
            }
          },
          unfulfilledSold: {
            $sum: {
              $cond: [
                { $and: [
                  { $eq: ['$isFulfilled', false] },
                  { $ne: ['$isFulfilled', null] }
                ]},
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
          totalProfit: { $sum: '$profit' },
          orderCount: { $sum: 1 }
        }
      }
    ]).toArray();

    for (const stat of componentAgg) {
      const summaryDoc = {
        date: startOfDay,
        componentSku: stat._id,
        componentProductName: stat.productName,
        weight: stat.weight,
        totalSold: stat.totalSold,
        totalRefunded: 0,
        netSold: stat.totalSold,
        directSales: stat.directSales,
        bundleSales: stat.bundleSales,
        totalRevenue: stat.totalRevenue,
        totalCost: stat.totalCost,
        totalProfit: stat.totalProfit,
        orderCount: stat.orderCount,
        lastUpdated: new Date(),
        createdAt: new Date(),
        updatedAt: new Date()
      };

      if (isFruitProduct(stat._id)) {
        summaryDoc.fulfilledSold = stat.fulfilledSold;
        summaryDoc.unfulfilledSold = stat.unfulfilledSold;
        summaryDoc.netUnfulfilled = stat.unfulfilledSold;
      }

      await dailyComponentSummary.insertOne(summaryDoc);
    }

    // Bundle summaries
    const bundleAgg = await bundleSales.aggregate([
      {
        $match: {
          orderDate: { $gte: startOfDay, $lte: endOfDay },
          action: 'sale'
        }
      },
      {
        $group: {
          _id: '$bundleSku',
          productName: { $first: '$bundleProductName' },
          totalSold: { $sum: '$quantitySold' },
          fulfilledSold: {
            $sum: {
              $cond: [
                { $and: [
                  { $eq: ['$isFulfilled', true] },
                  { $ne: ['$isFulfilled', null] }
                ]},
                '$quantitySold',
                0
              ]
            }
          },
          unfulfilledSold: {
            $sum: {
              $cond: [
                { $and: [
                  { $eq: ['$isFulfilled', false] },
                  { $ne: ['$isFulfilled', null] }
                ]},
                '$quantitySold',
                0
              ]
            }
          },
          totalRevenue: { $sum: '$totalPrice' },
          totalCost: { $sum: '$totalCost' },
          totalProfit: { $sum: '$profit' },
          orderCount: { $sum: 1 }
        }
      }
    ]).toArray();

    for (const stat of bundleAgg) {
      const summaryDoc = {
        date: startOfDay,
        bundleSku: stat._id,
        bundleProductName: stat.productName,
        totalSold: stat.totalSold,
        totalRefunded: 0,
        netSold: stat.totalSold,
        totalRevenue: stat.totalRevenue,
        totalCost: stat.totalCost,
        totalProfit: stat.totalProfit,
        orderCount: stat.orderCount,
        lastUpdated: new Date(),
        createdAt: new Date(),
        updatedAt: new Date()
      };

      if (isFruitProduct(stat._id)) {
        summaryDoc.fulfilledSold = stat.fulfilledSold;
        summaryDoc.unfulfilledSold = stat.unfulfilledSold;
        summaryDoc.netUnfulfilled = stat.unfulfilledSold;
      }

      await dailyBundleSummary.insertOne(summaryDoc);
    }
  }

  console.log('✅ Daily summaries built');
}

// ============================================
// MAIN RESET & IMPORT FUNCTION
// ============================================

async function resetAndImport(daysBack = 60) {
  let mongoClient;
  
  try {
    // Calculate date range
    const endDate = new Date();
    endDate.setHours(23, 59, 59, 999);
    
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);
    startDate.setHours(0, 0, 0, 0);

    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║          RESET & IMPORT - Sales Tracker                ║');
    console.log('╚════════════════════════════════════════════════════════╝');
    console.log(`\n⚠️  WARNING: This will DELETE all existing data!`);
    console.log(`📅 Importing fresh data for last ${daysBack} days (${Math.round(daysBack/30)} months):`);
    console.log(`   From: ${startDate.toLocaleDateString()}`);
    console.log(`   To:   ${endDate.toLocaleDateString()}`);

    // Connect to MongoDB
    console.log('\n🔌 Connecting to MongoDB...');
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    const db = mongoClient.db(DB_NAME);
    console.log('✅ Connected to MongoDB');

    // 🗑️ DELETE ALL EXISTING DATA
    console.log('\n🗑️  Deleting all existing data...');
    
    const collections = [
      'componentSales',
      'bundleSales',
      'dailyComponentSummary',
      'dailyBundleSummary'
    ];

    for (const collectionName of collections) {
      const collection = db.collection(collectionName);
      const result = await collection.deleteMany({});
      console.log(`   ✅ Deleted ${result.deletedCount} documents from ${collectionName}`);
    }

    console.log('✅ All data cleared');

    // Fetch orders from Shopify
    const orders = await fetchAllOrders(
      startDate.toISOString(),
      endDate.toISOString()
    );

    console.log(`\n📊 Found ${orders.length} orders to import`);

    if (orders.length === 0) {
      console.log('⚠️  No orders found in this date range');
      return;
    }

    // Process each order
    console.log(`\n⚙️  Processing ${orders.length} orders...`);
    let totalProcessed = 0;
    let totalSkipped = 0;
    let orderCount = 0;

    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      
      // Show progress every 10 orders
      if (i % 10 === 0) {
        console.log(`   Progress: ${i}/${orders.length} orders...`);
      }

      const result = await processHistoricalOrder(order, db);
      
      if (result.skipped) {
        totalSkipped++;
      } else {
        totalProcessed += result.processed || 0;
        totalSkipped += result.skipped || 0;
        orderCount++;
      }

      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    console.log('\n' + '═'.repeat(60));
    console.log(`✅ Import Complete!`);
    console.log(`   Date Range: ${startDate.toLocaleDateString()} to ${endDate.toLocaleDateString()}`);
    console.log(`   Days imported: ${daysBack} (${Math.round(daysBack/30)} months)`);
    console.log(`   Orders found: ${orders.length}`);
    console.log(`   Orders imported: ${orderCount}`);
    console.log(`   Items processed: ${totalProcessed}`);
    console.log(`   Items skipped: ${totalSkipped}`);
    console.log('═'.repeat(60));

    // Build daily summaries
    await rebuildDailySummaries(db, startDate, endDate);

    console.log('\n🎉 Reset & Import Complete!');
    console.log('\n📊 Summary of Changes:');
    console.log('   ✅ Revenue: Using ACTUAL prices from Shopify orders');
    console.log('   ✅ Costs: Using hardcoded costs from configuration');
    console.log('   ✅ Bundle revenue: Properly allocated to components');
    console.log('   ✅ 6-Pack: Equal split among 6 items (revenue & cost)');
    console.log('   ✅ Profit calculations: Corrected for all items');

  } catch (error) {
    console.error('\n❌ Import failed:', error);
    throw error;
  } finally {
    if (mongoClient) {
      await mongoClient.close();
      console.log('\n✅ MongoDB connection closed');
    }
  }
}

// ============================================
// RUN
// ============================================

if (require.main === module) {
  const daysBack = parseInt(process.argv[2]) || 60;
  
  console.log(`\n🚀 Starting RESET & IMPORT for last ${daysBack} days (${Math.round(daysBack/30)} months)...\n`);
  
  // Give user 5 seconds to cancel
  console.log('⏳ Starting in 5 seconds... Press Ctrl+C to cancel');
  
  setTimeout(() => {
    resetAndImport(daysBack)
      .then(() => process.exit(0))
      .catch(err => {
        console.error(err);
        process.exit(1);
      });
  }, 5000);
}

module.exports = { resetAndImport };