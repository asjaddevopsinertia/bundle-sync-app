// server.js
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const mongoose = require('mongoose');

const app = express();

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('✅ MongoDB Connected'))
.catch(err => console.error('❌ MongoDB Connection Error:', err));

// ============================================
// MONGODB SCHEMAS
// ============================================

// Component Sale Schema - Track ALL individual component sales
const componentSaleSchema = new mongoose.Schema({
  // Component Information (MAIN FOCUS)
  componentSku: {
    type: String,
    required: true,
    index: true
  },
  componentProductName: {
    type: String,
    required: true,
    index: true
  },
  quantitySold: {
    type: Number,
    required: true
  },
  
  // Product Details
  weight: {
    type: String,
    index: true
  },
  
  // Financial Data
  unitPrice: {
    type: Number,
    required: true
  },
  unitCost: {
    type: Number,
    required: true
  },
  totalPrice: {
    type: Number,
    required: true
  },
  totalCost: {
    type: Number,
    required: true
  },
  profit: {
    type: Number,
    required: true
  },
  
  // Sale Type
  saleType: {
    type: String,
    enum: ['direct', 'bundle'],
    required: true,
    index: true,
    default: 'direct'
  },
  
  // Bundle Information (only if saleType is 'bundle')
  bundleSku: {
    type: String,
    index: true
  },
  bundleProductName: String,
  
  // Order Information
  orderId: {
    type: String,
    required: true,
    index: true
  },
  orderName: String,
  orderDate: {
    type: Date,
    required: true,
    index: true
  },
  
  // Action tracking
  action: {
    type: String,
    enum: ['sale', 'refund', 'cancellation'],
    required: true,
    default: 'sale',
    index: true
  },
  
  // Inventory tracking
  inventoryBefore: Number,
  inventoryAfter: Number,
  
  // Metadata
  processedAt: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: true
});

componentSaleSchema.index({ componentSku: 1, orderDate: -1 });
componentSaleSchema.index({ orderDate: -1, action: 1 });
componentSaleSchema.index({ componentSku: 1, action: 1, orderDate: -1 });
componentSaleSchema.index({ saleType: 1, orderDate: -1 });

const ComponentSale = mongoose.model('ComponentSale', componentSaleSchema);

// NEW: Bundle Sale Schema - Track bundle sales separately
const bundleSaleSchema = new mongoose.Schema({
  // Bundle Information
  bundleSku: {
    type: String,
    required: true,
    index: true
  },
  bundleProductName: {
    type: String,
    required: true,
    index: true
  },
  quantitySold: {
    type: Number,
    required: true
  },
  
  // Financial Data (of the actual bundle product price)
  unitPrice: {
    type: Number,
    required: true
  },
  totalPrice: {
    type: Number,
    required: true
  },
  
  // Components included in this bundle
  components: [{
    sku: String,
    name: String,
    quantity: Number
  }],
  
  // Order Information
  orderId: {
    type: String,
    required: true,
    index: true
  },
  orderName: String,
  orderDate: {
    type: Date,
    required: true,
    index: true
  },
  
  // Action tracking
  action: {
    type: String,
    enum: ['sale', 'refund', 'cancellation'],
    required: true,
    default: 'sale',
    index: true
  },
  
  // Metadata
  processedAt: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: true
});

bundleSaleSchema.index({ bundleSku: 1, orderDate: -1 });
bundleSaleSchema.index({ orderDate: -1, action: 1 });

const BundleSale = mongoose.model('BundleSale', bundleSaleSchema);

// Daily Component Summary
const dailyComponentSummarySchema = new mongoose.Schema({
  date: {
    type: Date,
    required: true,
    index: true
  },
  componentSku: {
    type: String,
    required: true,
    index: true
  },
  componentProductName: String,
  weight: String,
  
  totalSold: {
    type: Number,
    default: 0
  },
  totalRefunded: {
    type: Number,
    default: 0
  },
  netSold: {
    type: Number,
    default: 0
  },
  
  directSales: {
    type: Number,
    default: 0
  },
  bundleSales: {
    type: Number,
    default: 0
  },
  
  totalRevenue: {
    type: Number,
    default: 0
  },
  totalCost: {
    type: Number,
    default: 0
  },
  totalProfit: {
    type: Number,
    default: 0
  },
  
  orderCount: {
    type: Number,
    default: 0
  },
  
  lastUpdated: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

dailyComponentSummarySchema.index({ date: 1, componentSku: 1 }, { unique: true });

const DailyComponentSummary = mongoose.model('DailyComponentSummary', dailyComponentSummarySchema);

// NEW: Daily Bundle Summary
const dailyBundleSummarySchema = new mongoose.Schema({
  date: {
    type: Date,
    required: true,
    index: true
  },
  bundleSku: {
    type: String,
    required: true,
    index: true
  },
  bundleProductName: String,
  
  totalSold: {
    type: Number,
    default: 0
  },
  totalRefunded: {
    type: Number,
    default: 0
  },
  netSold: {
    type: Number,
    default: 0
  },
  
  totalRevenue: {
    type: Number,
    default: 0
  },
  
  orderCount: {
    type: Number,
    default: 0
  },
  
  lastUpdated: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

dailyBundleSummarySchema.index({ date: 1, bundleSku: 1 }, { unique: true });

const DailyBundleSummary = mongoose.model('DailyBundleSummary', dailyBundleSummarySchema);

// ============================================
// PRODUCT PRICING & COST CONFIGURATION
// ============================================

const COMPONENT_PRICING = {
  // 8oz products
  'MG-SML-FS-08J': { 
    price: 13.99, 
    cost: 2.59, 
    weight: '8oz',
    name: 'Strawberry & Meyer Lemon Fruit Spread'
  },
  'MG-RTT-FS-08J': { 
    price: 13.99, 
    cost: 3.12, 
    weight: '8oz',
    name: 'Raspberry & Tango Tangerine Fruit Spread'
  },
  'MG-PX-MM-08J': { 
    price: 13.99, 
    cost: 2.42, 
    weight: '8oz',
    name: '"Sunrise" Pixie Tangerine Marmalade'
  },
  'MG-RVOA-FS-08J': { 
    price: 13.99, 
    cost: 2.60, 
    weight: '8oz',
    name: 'Ruby Valencia & Apricot Fruit Spread'
  },
  'MG-CCH-MM-08J': { 
    price: 13.99, 
    cost: 2.66, 
    weight: '8oz',
    name: 'Cara Cara & Hibiscus Marmalade'
  },
  'MG-MLH-MM-08J': { 
    price: 13.99, 
    cost: 2.82, 
    weight: '8oz',
    name: 'Meyer Lemon & Honey Marmalade'
  },
  
  // 5oz products
  'MG-PX-MM-05J': { 
    price: 9.00, 
    cost: 1.93, 
    weight: '5oz',
    name: '"Sunrise" Pixie Tangerine Marmalade'
  },
  'MG-MLH-MM-05J': { 
    price: 9.00, 
    cost: 1.93, 
    weight: '5oz',
    name: 'Meyer Lemon & Honey Marmalade'
  },
  'MG-CCH-MM-05J': { 
    price: 9.00, 
    cost: 1.93, 
    weight: '5oz',
    name: 'Cara Cara & Hibiscus Marmalade'
  },
  'MG-RVOA-FS-05J': { 
    price: 9.00, 
    cost: 2.14, 
    weight: '4.5oz',
    name: 'Ruby Valencia & Apricot Fruit Spread'
  },
  'MG-OBA-FS-05J': { 
    price: 9.00, 
    cost: 2.07, 
    weight: '4.5oz',
    name: 'Oroblanco & Agave Fruit Spread'
  },
  'MG-NCT-MM-05J': { 
    price: 9.00, 
    cost: 1.93, 
    weight: '4.5oz',
    name: '"Tea Time" Navel Orange & Ceylon Tea Marmalade'
  },
  
  // 4.5oz products (if you have any)
  // Add more as needed
};

// NEW: Bundle Pricing (actual bundle prices from Shopify)
const BUNDLE_PRICING = {
  'MG-SML-FS-08J-DTC-2PK': {
    price: 24.00, // Your actual bundle price
    name: '2-Pack Strawberry & Meyer Lemon Fruit Spread'
  },
  'MG-RTT-FS-08J-DTC-2PK': {
    price: 24.00,
    name: '2-Pack Raspberry & Tango Tangerine Fruit Spread'
  },
  'MG-PX-MM-08J-DTC-2PK': {
    price: 24.00,
    name: '2-Pack "Sunrise" Pixie Tangerine Marmalade'
  },
  'MG-RVOA-FS-08J-DTC-2PK': {
    price: 24.00,
    name: '2-Pack Ruby Valencia & Apricot Fruit Spread'
  },
  'MG-CCH-MM-08J-DTC-2PK': {
    price: 24.00,
    name: '2-Pack Cara Cara & Hibiscus Marmalade'
  },
  'MG-MLH-MM-08J-DTC-2PK': {
    price: 24.00,
    name: '2-Pack Meyer Lemon & Honey Marmalade'
  },
  'MG-MIX-05J-DTC-6PK': {
    price: 60.00, // Your actual 6-pack price
    name: '"Party Of Six" Gift Set'
  }
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
    name: sku
  };
}

function isTrackableIndividual(sku) {
  return COMPONENT_PRICING.hasOwnProperty(sku);
}

// ============================================
// MONGODB HELPER FUNCTIONS
// ============================================

// Save component sale
async function saveComponentSale(saleData) {
  try {
    const sale = new ComponentSale(saleData);
    await sale.save();
    
    const saleTypeIcon = saleData.saleType === 'direct' ? '🛒' : '📦';
    console.log(`💾 ${saleTypeIcon} Component: ${saleData.componentSku} (${saleData.quantitySold}x) - $${saleData.totalPrice.toFixed(2)} [${saleData.saleType}]`);
    return sale;
  } catch (error) {
    console.error('❌ Error saving component sale:', error.message);
    throw error;
  }
}

// NEW: Save bundle sale
async function saveBundleSale(saleData) {
  try {
    const sale = new BundleSale(saleData);
    await sale.save();
    
    console.log(`💾 📦 Bundle: ${saleData.bundleSku} (${saleData.quantitySold}x) - $${saleData.totalPrice.toFixed(2)}`);
    return sale;
  } catch (error) {
    console.error('❌ Error saving bundle sale:', error.message);
    throw error;
  }
}

// Update daily component summary
async function updateDailyComponentSummary(componentSku, date) {
  try {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);
    
    const aggregation = await ComponentSale.aggregate([
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
                { $and: [
                  { $eq: ['$action', 'sale'] },
                  { $eq: ['$saleType', 'direct'] }
                ]},
                '$quantitySold',
                0
              ]
            }
          },
          bundleSales: {
            $sum: {
              $cond: [
                { $and: [
                  { $eq: ['$action', 'sale'] },
                  { $eq: ['$saleType', 'bundle'] }
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
    ]);

    if (aggregation.length > 0) {
      const stats = aggregation[0];
      const netSold = stats.totalSold - stats.totalRefunded;
      const totalProfit = stats.totalRevenue - stats.totalCost;

      await DailyComponentSummary.findOneAndUpdate(
        { 
          date: startOfDay,
          componentSku: componentSku
        },
        {
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
          lastUpdated: new Date()
        },
        { upsert: true, new: true }
      );
    }
  } catch (error) {
    console.error('❌ Error updating daily component summary:', error.message);
  }
}

// NEW: Update daily bundle summary
async function updateDailyBundleSummary(bundleSku, date) {
  try {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);
    
    const aggregation = await BundleSale.aggregate([
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
          totalRevenue: {
            $sum: {
              $cond: [{ $eq: ['$action', 'sale'] }, '$totalPrice', 0]
            }
          },
          orderCount: { $sum: 1 }
        }
      }
    ]);

    if (aggregation.length > 0) {
      const stats = aggregation[0];
      const netSold = stats.totalSold - stats.totalRefunded;

      await DailyBundleSummary.findOneAndUpdate(
        { 
          date: startOfDay,
          bundleSku: bundleSku
        },
        {
          bundleProductName: stats.productName,
          totalSold: stats.totalSold,
          totalRefunded: stats.totalRefunded,
          netSold: netSold,
          totalRevenue: stats.totalRevenue,
          orderCount: stats.orderCount,
          lastUpdated: new Date()
        },
        { upsert: true, new: true }
      );

      console.log(`📊 Updated bundle daily summary: ${bundleSku} - ${netSold} units, $${stats.totalRevenue.toFixed(2)} revenue`);
    }
  } catch (error) {
    console.error('❌ Error updating daily bundle summary:', error.message);
  }
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
  'MG-SML-FS-08J-DTC-2PK': [
    { sku: 'MG-SML-FS-08J', quantity: 2 },
  ],
  'MG-RTT-FS-08J-DTC-2PK': [
    { sku: 'MG-RTT-FS-08J', quantity: 2 },
  ],
  'MG-PX-MM-08J-DTC-2PK': [
    { sku: 'MG-PX-MM-08J', quantity: 2 },
  ],
  'MG-RVOA-FS-08J-DTC-2PK': [
    { sku: 'MG-RVOA-FS-08J', quantity: 2 },
  ],
  'MG-CCH-MM-08J-DTC-2PK': [
    { sku: 'MG-CCH-MM-08J', quantity: 2 },
  ],
  'MG-MLH-MM-08J-DTC-2PK': [
    { sku: 'MG-MLH-MM-08J', quantity: 2 },
  ],
  'MG-MIX-05J-DTC-6PK': [
    { sku: 'MG-PX-MM-05J', quantity: 1 },
    { sku: 'MG-MLH-MM-05J', quantity: 1 },
    { sku: 'MG-CCH-MM-05J', quantity: 1 },
    { sku: 'MG-RVOA-FS-05J', quantity: 1 },
    { sku: 'MG-OBA-FS-05J', quantity: 1 },
    { sku: 'MG-NCT-MM-05J', quantity: 1 },
  ]
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
  
  const unitPrice = pricingInfo.price;
  const unitCost = pricingInfo.cost;
  const totalPrice = unitPrice * quantity;
  const totalCost = unitCost * quantity;
  const profit = totalPrice - totalCost;
  
  try {
    const saleData = {
      componentSku: sku,
      componentProductName: variant?.displayName || pricingInfo.name || sku,
      quantitySold: quantity,
      weight: pricingInfo.weight,
      unitPrice: unitPrice,
      unitCost: unitCost,
      totalPrice: totalPrice,
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
      inventoryAfter: variant?.inventoryQuantity || null
    };

    await saveComponentSale(saleData);
    await updateDailyComponentSummary(sku, saleData.orderDate);
    
    return saleData;
  } catch (dbError) {
    console.error('❌ Failed to save direct sale to MongoDB:', dbError.message);
    return null;
  }
}

// Process line items - UPDATED to track bundles AND components
async function processLineItems(lineItems, action = 'reduce', orderData = {}) {
  const results = [];
  
  for (const item of lineItems) {
    const sku = item.sku;
    const quantity = item.quantity;

    if (!sku) {
      console.log(`⚠️  Skipping item without SKU: ${item.title || item.name}`);
      continue;
    }

    // Check if this is a BUNDLE
    if (BUNDLE_CONFIG[sku]) {
      console.log(`\n📦 Processing bundle: ${sku} (${quantity}x)`);
      
      const bundleVariant = await getVariantBySKU(sku);
      const bundleProductName = bundleVariant?.displayName || item.title || sku;
      
      // Get bundle pricing
      const bundlePricing = getBundlePricing(sku);
      
      // NEW: Save bundle sale
      try {
        const bundleSaleData = {
          bundleSku: sku,
          bundleProductName: bundleProductName,
          quantitySold: quantity,
          unitPrice: bundlePricing.price,
          totalPrice: bundlePricing.price * quantity,
          components: BUNDLE_CONFIG[sku].map(comp => {
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
          action: action === 'reduce' ? 'sale' : action === 'restore' ? 'cancellation' : action
        };

        await saveBundleSale(bundleSaleData);
        await updateDailyBundleSummary(sku, bundleSaleData.orderDate);
        
      } catch (dbError) {
        console.error('❌ Failed to save bundle to MongoDB:', dbError.message);
      }
      
      // Process component inventory and tracking
      const components = BUNDLE_CONFIG[sku];
      
      for (const component of components) {
        const totalQuantity = component.quantity * quantity;
        const quantityDelta = action === 'reduce' ? -totalQuantity : totalQuantity;
        
        console.log(`   ${action === 'reduce' ? '➖' : '➕'} ${component.sku}: ${Math.abs(totalQuantity)}`);
        
        const result = await adjustInventory(
          component.sku, 
          quantityDelta,
          action === 'reduce' ? 'sold' : 'returned'
        );
        
        const pricingInfo = getComponentPricing(component.sku);
        
        const unitPrice = pricingInfo.price;
        const unitCost = pricingInfo.cost;
        const totalPrice = unitPrice * totalQuantity;
        const totalCost = unitCost * totalQuantity;
        const profit = totalPrice - totalCost;
        
        try {
          const saleData = {
            componentSku: component.sku,
            componentProductName: result.productName || pricingInfo.name || component.sku,
            quantitySold: totalQuantity,
            weight: pricingInfo.weight,
            unitPrice: unitPrice,
            unitCost: unitCost,
            totalPrice: totalPrice,
            totalCost: totalCost,
            profit: profit,
            saleType: 'bundle',
            bundleSku: sku,
            bundleProductName: bundleProductName,
            orderId: orderData.id?.toString() || 'unknown',
            orderName: orderData.name || orderData.order_number || 'N/A',
            orderDate: orderData.created_at ? new Date(orderData.created_at) : new Date(),
            action: action === 'reduce' ? 'sale' : action === 'restore' ? 'cancellation' : action,
            inventoryBefore: result.oldQuantity,
            inventoryAfter: result.newQuantity
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
app.get('/api/component-sales/summary', async (req, res) => {
  try {
    const { 
      days = 7,
      startDate,
      endDate,
      saleType
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

    let matchQuery = {
      ...dateQuery,
      action: 'sale'
    };

    if (saleType) {
      matchQuery.saleType = saleType;
    }

    const summary = await ComponentSale.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: '$componentSku',
          productName: { $first: '$componentProductName' },
          weight: { $first: '$weight' },
          unitPrice: { $first: '$unitPrice' },
          unitCost: { $first: '$unitCost' },
          totalQuantitySold: { $sum: '$quantitySold' },
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
          orderCount: { $addToSet: '$orderId' }
        }
      },
      {
        $project: {
          _id: 0,
          componentSku: '$_id',
          productName: 1,
          weight: 1,
          unitPrice: 1,
          unitCost: 1,
          quantitySold: '$totalQuantitySold',
          directSales: 1,
          bundleSales: 1,
          totalRevenue: { $round: ['$totalRevenue', 2] },
          totalCost: { $round: ['$totalCost', 2] },
          totalProfit: { $round: ['$totalProfit', 2] },
          orderCount: { $size: '$orderCount' },
          avgProfitPerUnit: { 
            $round: [
              { $divide: ['$totalProfit', '$totalQuantitySold'] }, 
              2
            ] 
          }
        }
      },
      { $sort: { quantitySold: -1 } }
    ]);

    const grandTotals = summary.reduce((acc, item) => {
      acc.totalUnits += item.quantitySold;
      acc.directSales += item.directSales;
      acc.bundleSales += item.bundleSales;
      acc.totalRevenue += item.totalRevenue;
      acc.totalCost += item.totalCost;
      acc.totalProfit += item.totalProfit;
      return acc;
    }, { totalUnits: 0, directSales: 0, bundleSales: 0, totalRevenue: 0, totalCost: 0, totalProfit: 0 });

    res.json({
      success: true,
      period: {
        days: parseInt(days),
        startDate: dateQuery.orderDate?.$gte,
        endDate: dateQuery.orderDate?.$lte || new Date()
      },
      summary: {
        components: summary,
        totals: {
          totalUnits: grandTotals.totalUnits,
          directSales: grandTotals.directSales,
          bundleSales: grandTotals.bundleSales,
          totalRevenue: Math.round(grandTotals.totalRevenue * 100) / 100,
          totalCost: Math.round(grandTotals.totalCost * 100) / 100,
          totalProfit: Math.round(grandTotals.totalProfit * 100) / 100,
          profitMargin: grandTotals.totalRevenue > 0 
            ? Math.round((grandTotals.totalProfit / grandTotals.totalRevenue) * 100 * 100) / 100
            : 0
        }
      }
    });

  } catch (error) {
    console.error('Error fetching component sales summary:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// NEW: Bundle sales summary
app.get('/api/bundle-sales/summary', async (req, res) => {
  try {
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

    const summary = await BundleSale.aggregate([
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
    ]);

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

// Get detailed sales for a specific component
app.get('/api/component-sales/:sku', async (req, res) => {
  try {
    const { sku } = req.params;
    const { days = 7 } = req.query;

    const daysAgo = new Date();
    daysAgo.setDate(daysAgo.getDate() - parseInt(days));

    const sales = await ComponentSale.find({
      componentSku: sku,
      orderDate: { $gte: daysAgo }
    })
    .select('-__v')
    .sort({ orderDate: -1 })
    .limit(100);

    const summary = await ComponentSale.aggregate([
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
                { $and: [
                  { $eq: ['$action', 'sale'] },
                  { $eq: ['$saleType', 'direct'] }
                ]},
                '$quantitySold',
                0
              ]
            }
          },
          bundleSales: {
            $sum: {
              $cond: [
                { $and: [
                  { $eq: ['$action', 'sale'] },
                  { $eq: ['$saleType', 'bundle'] }
                ]},
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
    ]);

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

// NEW: Get detailed sales for a specific bundle
app.get('/api/bundle-sales/:sku', async (req, res) => {
  try {
    const { sku } = req.params;
    const { days = 7 } = req.query;

    const daysAgo = new Date();
    daysAgo.setDate(daysAgo.getDate() - parseInt(days));

    const sales = await BundleSale.find({
      bundleSku: sku,
      orderDate: { $gte: daysAgo }
    })
    .select('-__v')
    .sort({ orderDate: -1 })
    .limit(100);

    const summary = await BundleSale.aggregate([
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
    ]);

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

// Daily breakdown for components
app.get('/api/component-sales/daily', async (req, res) => {
  try {
    const { days = 7, sku } = req.query;

    const daysAgo = new Date();
    daysAgo.setDate(daysAgo.getDate() - parseInt(days));
    daysAgo.setHours(0, 0, 0, 0);

    let query = { date: { $gte: daysAgo } };
    if (sku) {
      query.componentSku = sku;
    }

    const dailyData = await DailyComponentSummary.find(query)
      .sort({ date: -1, netSold: -1 })
      .limit(1000);

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

// NEW: Daily breakdown for bundles
app.get('/api/bundle-sales/daily', async (req, res) => {
  try {
    const { days = 7, sku } = req.query;

    const daysAgo = new Date();
    daysAgo.setDate(daysAgo.getDate() - parseInt(days));
    daysAgo.setHours(0, 0, 0, 0);

    let query = { date: { $gte: daysAgo } };
    if (sku) {
      query.bundleSku = sku;
    }

    const dailyData = await DailyBundleSummary.find(query)
      .sort({ date: -1, netSold: -1 })
      .limit(1000);

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

app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    mongoConnected: mongoose.connection.readyState === 1
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
║  MongoDB: ${mongoose.connection.readyState === 1 ? '✅ Connected'.padEnd(40) : '❌ Disconnected'.padEnd(40)} ║
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