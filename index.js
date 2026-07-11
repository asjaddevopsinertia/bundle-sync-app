// server.js
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

const app = express();

// Configuration
const SHOPIFY_CONFIG = {
  shop: process.env.SHOPIFY_SHOP_DOMAIN,
  accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
  apiVersion: '2024-01',
  webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET
};

// Bundle Configuration
const BUNDLE_CONFIG = {
  'MG-SML-FS-08J-DTC-2PK': [
    { sku: 'MG-SML-FS-08J', quantity: 2 },
  ],
  'MG-RTT-FS-08J-DTC-2PK': [
    { sku: 'MG-RTT-FS-08J', quantity: 2 },
  ],
  'MG-PX-MM-08J-DTC-2PK':[
    { sku: 'MG-PX-MM-08J', quantity: 2 },
  ],
  'MG-RVOA-FS-08J-DTC-2PK':[
    { sku: 'MG-RVOA-FS-08J', quantity: 2 },
  ],
  'MG-CCH-MM-08J-DTC-2PK':[
    { sku: 'MG-CCH-MM-08J', quantity: 2 },
  ],
  'MG-MLH-MM-08J-DTC-2PK':[
    { sku: 'MG-MLH-MM-08J', quantity: 2 },
  ]
};

// Simple: Just return the access token (no OAuth needed)
function getAccessToken() {
  if (!SHOPIFY_CONFIG.accessToken) {
    throw new Error('SHOPIFY_ACCESS_TOKEN is not set in environment variables');
  }
  return SHOPIFY_CONFIG.accessToken;
}

// GraphQL API Request
async function shopifyGraphQL(query, variables = {}) {
  const accessToken = getAccessToken();
  
  try {
    const response = await axios.post(
      `https://${SHOPIFY_CONFIG.shop}/admin/api/${SHOPIFY_CONFIG.apiVersion}/graphql.json`,
      {
        query,
        variables
      },
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

// Middleware to capture raw body for webhook verification
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

// Verify Shopify Webhook
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

// Get variant by SKU - checks both variant and product level
async function getVariantBySKU(sku) {
  // First try to find as variant
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

    // If not found as variant, try as product
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

// Adjust inventory using REST API (simple and reliable)
async function adjustInventory(sku, quantityDelta, reason = 'other') {
  try {
    console.log(`🔄 Adjusting inventory for SKU: ${sku}, Delta: ${quantityDelta}`);
    
    // Get variant info using GraphQL
    const variant = await getVariantBySKU(sku);
    
    if (!variant) {
      console.error(`❌ Variant not found for SKU: ${sku}`);
      return { success: false, error: 'Variant not found' };
    }

    const currentInventory = variant.inventoryQuantity || 0;
    const newInventory = Math.max(0, currentInventory + quantityDelta);

    console.log(`   Current: ${currentInventory}, New: ${newInventory} (${quantityDelta > 0 ? '+' : ''}${quantityDelta})`);

    // Get inventory level
    const inventoryLevel = variant.inventoryItem?.inventoryLevels?.edges[0]?.node;
    
    if (!inventoryLevel) {
      console.error(`❌ No inventory level found for SKU: ${sku}`);
      return { success: false, error: 'No inventory level found' };
    }

    // Extract numeric IDs from GraphQL global IDs
    const inventoryItemId = variant.inventoryItem.id.split('/').pop();
    const locationId = inventoryLevel.location.id.split('/').pop();

    // Use REST API to set inventory
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
        delta: quantityDelta
      };
    }

    return {
      success: true,
      oldQuantity: currentInventory,
      newQuantity: newInventory,
      sku: sku,
      delta: quantityDelta
    };

  } catch (error) {
    console.error(`❌ Error adjusting inventory for ${sku}:`);
    
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Data:`, error.response.data);
      return { 
        success: false, 
        error: error.response.data.errors || error.message 
      };
    }
    
    console.error(`   Error:`, error.message);
    return { success: false, error: error.message };
  }
}

// Process line items and adjust inventory for bundles
async function processLineItems(lineItems, action = 'reduce') {
  const results = [];
  
  for (const item of lineItems) {
    const sku = item.sku;
    const quantity = item.quantity;

    // Skip items without SKU
    if (!sku) {
      console.log(`⚠️  Skipping item without SKU: ${item.title || item.name}`);
      continue;
    }

    // Check if this SKU is a bundle
    if (BUNDLE_CONFIG[sku]) {
      console.log(`\n📦 Processing bundle: ${sku} (${quantity}x)`);
      
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
        
        results.push({
          bundleSku: sku,
          componentSku: component.sku,
          quantity: totalQuantity,
          action,
          result
        });

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } else {
      console.log(`ℹ️  SKU ${sku} is not a bundle, skipping`);
    }
  }
  
  return results;
}

// Webhook: Order Created
app.post('/webhooks/orders/create', verifyWebhook, async (req, res) => {
  console.log('\n📝 Order created webhook received');
  
  // Respond immediately to Shopify
  res.status(200).send('OK');
  
  try {
    const order = req.body;
    const lineItems = order.line_items;
    
    console.log(`Processing order ${order.name} with ${lineItems.length} items`);
    
    const results = await processLineItems(lineItems, 'reduce');
    
    console.log('✅ Order processing complete');
    if (results.length > 0) {
      console.table(results.map(r => ({
        Bundle: r.bundleSku,
        Component: r.componentSku,
        Qty: r.quantity,
        Success: r.result.success ? '✅' : '❌'
      })));
    }
  } catch (error) {
    console.error('❌ Error processing order creation:', error);
  }
});

// Webhook: Order Cancelled
app.post('/webhooks/orders/cancelled', verifyWebhook, async (req, res) => {
  console.log('\n🚫 Order cancelled webhook received');
  
  res.status(200).send('OK');
  
  try {
    const order = req.body;
    const lineItems = order.line_items;
    
    console.log(`Processing cancellation for order ${order.name}`);
    
    const results = await processLineItems(lineItems, 'restore');
    
    console.log('✅ Order cancellation processing complete');
    if (results.length > 0) {
      console.table(results.map(r => ({
        Bundle: r.bundleSku,
        Component: r.componentSku,
        Qty: r.quantity,
        Success: r.result.success ? '✅' : '❌'
      })));
    }
  } catch (error) {
    console.error('❌ Error processing order cancellation:', error);
  }
});

// Webhook: Refund Created
// app.post('/webhooks/refunds/create', verifyWebhook, async (req, res) => {
//   console.log('\n💰 Refund created webhook received');
  
//   res.status(200).send('OK');
  
//   try {
//     const refund = req.body;
    
//     const refundLineItems = refund.refund_line_items.map(item => ({
//       sku: item.line_item.sku,
//       quantity: item.quantity,
//       title: item.line_item.title
//     }));
    
//     console.log(`Processing refund for order ${refund.order_id}`);
    
//     const results = await processLineItems(refundLineItems, 'restore');
    
//     console.log('✅ Refund processing complete');
//   } catch (error) {
//     console.error('❌ Error processing refund:', error);
//   }
// });

// Webhook: Order Edited
app.post('/webhooks/orders/edited', verifyWebhook, async (req, res) => {
  console.log('\n✏️ Order edited webhook received');
  
  res.status(200).send('OK');
  
  try {
    const orderEdit = req.body;
    
    // Process removed items
    if (orderEdit.line_items_removed && orderEdit.line_items_removed.length > 0) {
      console.log('Processing removed items...');
      await processLineItems(orderEdit.line_items_removed, 'restore');
    }
    
    // Process added items
    if (orderEdit.line_items_added && orderEdit.line_items_added.length > 0) {
      console.log('Processing added items...');
      await processLineItems(orderEdit.line_items_added, 'reduce');
    }
    
    console.log('✅ Order edit processing complete');
  } catch (error) {
    console.error('❌ Error processing order edit:', error);
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    shop: SHOPIFY_CONFIG.shop,
    hasToken: !!SHOPIFY_CONFIG.accessToken
  });
});

// Test endpoint to verify authentication
app.get('/test/auth', async (req, res) => {
  try {
    const query = `{ shop { name email } }`;
    const response = await shopifyGraphQL(query);
    
    res.json({ 
      success: true, 
      message: 'Authentication successful',
      shop: response.data.shop
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Test endpoint to get variant info
app.get('/test/variant/:sku', async (req, res) => {
  try {
    const variant = await getVariantBySKU(req.params.sku);
    res.json(variant);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test endpoint to manually adjust inventory
app.post('/test/adjust-inventory', async (req, res) => {
  const { sku, quantity } = req.body;
  
  if (!sku || quantity === undefined) {
    return res.status(400).json({ 
      error: 'Missing required fields: sku and quantity' 
    });
  }
  
  try {
    const result = await adjustInventory(sku, parseInt(quantity), 'correction');
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test endpoint to simulate order processing
app.post('/test/process-order', async (req, res) => {
  const { lineItems, action } = req.body;
  
  try {
    const results = await processLineItems(lineItems, action || 'reduce');
    res.json({ success: true, results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
//   console.log(`
// ╔════════════════════════════════════════════════════════╗
// ║  Shopify Bundle Inventory Manager                     ║
// ║  Server running on port ${PORT}                           ║
// ║                                                        ║
// ║  Shop: ${SHOPIFY_CONFIG.shop?.padEnd(42) || 'Not configured'.padEnd(42)} ║
// ║  Token: ${SHOPIFY_CONFIG.accessToken ? '✅ Configured'.padEnd(42) : '❌ Missing'.padEnd(42)} ║
// ║                                                        ║
// ║  Configured bundles:                                   ║
// ${Object.keys(BUNDLE_CONFIG).map(key => `║    - ${key.padEnd(46)} ║`).join('\n')}
// ║                                                        ║
// ║  Test endpoints:                                       ║
// ║    GET  /health                                        ║
// ║    GET  /test/auth                                     ║
// ║    GET  /test/variant/:sku                             ║
// ║    POST /test/adjust-inventory                         ║
// ║    POST /test/process-order                            ║
// ╚════════════════════════════════════════════════════════╝
//   `);

console.log("server started successfully")
});

module.exports = app;