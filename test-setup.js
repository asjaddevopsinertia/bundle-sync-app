require('dotenv').config();
const axios = require('axios');

const SHOPIFY_CONFIG = {
  shop: process.env.SHOPIFY_SHOP_DOMAIN,
  accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
};

console.log("shopify config:", {
  shop: SHOPIFY_CONFIG.shop,
  hasToken: !!SHOPIFY_CONFIG.accessToken
});

const BUNDLE_CONFIG = {
  '3-set': [
    { sku: '123', quantity: 1 },
    { sku: '456', quantity: 1 },
    { sku: '789', quantity: 1 },
  ],
  '2-set': [
    { sku: '123', quantity: 1 },
    { sku: '456', quantity: 1 }
  ]
};

async function getAccessToken() {
  return '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'
}

async function shopifyGraphQL(query, variables = {}) {
  const accessToken = await getAccessToken();
  
  const response = await axios.post(
    `https://${SHOPIFY_CONFIG.shop}/admin/api/2024-01/graphql.json`,
    { query, variables },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken
      }
    }
  );

  if (response.data.errors) {
    throw new Error(JSON.stringify(response.data.errors));
  }

  return response.data;
}

// Updated function to check both variant and product by SKU
async function getVariantBySKU(sku) {
  const query = `
    query getVariantBySKU($query: String!) {
      productVariants(first: 1, query: $query) {
        edges {
          node {
            id
            sku
            inventoryQuantity
            displayName
            inventoryItem {
              id
            }
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
    const response = await shopifyGraphQL(query, { query: `sku:${sku}` });
    const edges = response.data.productVariants.edges;
    
    if (edges.length > 0) {
      return {
        found: true,
        type: 'variant',
        data: edges[0].node
      };
    }
    
    // If not found as variant, try searching as product SKU
    return await getProductBySKU(sku);
    
  } catch (error) {
    console.error(`Error searching for SKU ${sku}:`, error.message);
    return { found: false, type: 'error', error: error.message };
  }
}

// Check if SKU exists at product level
async function getProductBySKU(sku) {
  const query = `
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
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  try {
    const response = await shopifyGraphQL(query, { query: `sku:${sku}` });
    const edges = response.data.products.edges;
    
    if (edges.length > 0) {
      const product = edges[0].node;
      const variant = product.variants.edges[0]?.node;
      
      return {
        found: true,
        type: 'product',
        data: {
          id: variant?.id,
          sku: variant?.sku,
          inventoryQuantity: variant?.inventoryQuantity,
          displayName: product.hasOnlyDefaultVariant ? product.title : variant?.displayName,
          inventoryItem: variant?.inventoryItem,
          product: {
            id: product.id,
            title: product.title,
            hasOnlyDefaultVariant: product.hasOnlyDefaultVariant
          }
        }
      };
    }
    
    return { found: false, type: 'not_found' };
  } catch (error) {
    console.error(`Error searching product by SKU ${sku}:`, error.message);
    return { found: false, type: 'error', error: error.message };
  }
}

async function testConfiguration() {
  console.log('\n🧪 Testing Bundle Configuration\n');
  console.log('═'.repeat(60));
  
  // Test 1: Authentication
  console.log('\n1️⃣  Testing Authentication...');
  try {
    const token = await getAccessToken();
    if (!token) {
      throw new Error('Access token is empty');
    }
    
    // Test the token with a simple query
    const testQuery = `{ shop { name } }`;
    const testResult = await shopifyGraphQL(testQuery);
    
    console.log(`   ✅ Authentication successful`);
    console.log(`   Shop: ${testResult.data.shop.name}\n`);
  } catch (error) {
    console.log('   ❌ Authentication failed - check your credentials');
    console.log(`   Error: ${error.message}\n`);
    return;
  }

  // Test 2: Check all SKUs exist
  console.log('2️⃣  Checking if all SKUs exist in Shopify...\n');
  
  const allSkus = new Set();
  
  // Collect all unique SKUs from bundles
  for (const [bundleSku, components] of Object.entries(BUNDLE_CONFIG)) {
    allSkus.add(bundleSku);
    components.forEach(c => allSkus.add(c.sku));
  }

  const skuResults = {};
  
  for (const sku of allSkus) {
    try {
      const result = await getVariantBySKU(sku);
      
      if (result.found) {
        const variant = result.data;
        skuResults[sku] = {
          found: true,
          searchType: result.type,
          product: variant.product.title,
          displayName: variant.displayName,
          currentInventory: variant.inventoryQuantity,
          hasOnlyDefaultVariant: variant.product.hasOnlyDefaultVariant
        };
        
        console.log(`   ✅ ${sku} (found as ${result.type})`);
        console.log(`      Product: ${variant.product.title}`);
        console.log(`      Variant: ${variant.displayName}`);
        console.log(`      Current Inventory: ${variant.inventoryQuantity ?? 'N/A'}`);
        console.log(`      Type: ${variant.product.hasOnlyDefaultVariant ? 'Single variant product' : 'Multi-variant product'}`);
      } else {
        skuResults[sku] = { found: false };
        console.log(`   ❌ ${sku} - NOT FOUND IN SHOPIFY`);
        if (result.error) {
          console.log(`      Error: ${result.error}`);
        }
      }
      console.log('');
      
      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 300));
    } catch (error) {
      console.log(`   ❌ ${sku} - Error: ${error.message}\n`);
      skuResults[sku] = { found: false, error: error.message };
    }
  }

  // Test 3: Validate Bundle Configuration
  console.log('\n3️⃣  Validating Bundle Configuration...\n');
  
  for (const [bundleSku, components] of Object.entries(BUNDLE_CONFIG)) {
    console.log(`   📦 Bundle: ${bundleSku}`);
    
    if (!skuResults[bundleSku]?.found) {
      console.log(`      ⚠️  Bundle SKU not found in Shopify`);
      console.log(`      💡 Create a product with SKU "${bundleSku}" and disable inventory tracking`);
    } else {
      console.log(`      ✅ Bundle product exists: ${skuResults[bundleSku].product}`);
      console.log(`      Type: ${skuResults[bundleSku].searchType}`);
    }
    
    console.log(`      Components:`);
    
    let allComponentsExist = true;
    for (const component of components) {
      const exists = skuResults[component.sku]?.found;
      const icon = exists ? '✅' : '❌';
      console.log(`         ${icon} ${component.sku} (qty: ${component.quantity})`);
      
      if (exists) {
        console.log(`            → ${skuResults[component.sku].product}`);
        console.log(`            → Inventory: ${skuResults[component.sku].currentInventory ?? 'N/A'}`);
        console.log(`            → Type: ${skuResults[component.sku].searchType}`);
      } else {
        console.log(`            → ⚠️  NOT FOUND - Create a product with this SKU`);
      }
      
      if (!exists) allComponentsExist = false;
    }
    
    if (allComponentsExist) {
      console.log(`      ✅ All components exist\n`);
    } else {
      console.log(`      ❌ Some components are missing\n`);
    }
  }

  // Test 4: Summary
  console.log('\n4️⃣  Summary\n');
  
  const totalSkus = allSkus.size;
  const foundSkus = Object.values(skuResults).filter(r => r.found).length;
  const missingSkus = totalSkus - foundSkus;
  
  // Count by type
  const variantCount = Object.values(skuResults).filter(r => r.found && r.searchType === 'variant').length;
  const productCount = Object.values(skuResults).filter(r => r.found && r.searchType === 'product').length;
  
  console.log(`   Total SKUs checked: ${totalSkus}`);
  console.log(`   ✅ Found: ${foundSkus}`);
  console.log(`      - As variants: ${variantCount}`);
  console.log(`      - As products: ${productCount}`);
  console.log(`   ❌ Missing: ${missingSkus}`);
  
  if (missingSkus === 0) {
    console.log('\n   🎉 Configuration is perfect! Ready to use.\n');
  } else {
    console.log('\n   ⚠️  Please fix missing SKUs before using.\n');
    console.log('   Missing SKUs:');
    for (const [sku, result] of Object.entries(skuResults)) {
      if (!result.found) {
        console.log(`      - ${sku}`);
      }
    }
    console.log('\n   💡 To fix:');
    console.log('   1. Go to Shopify Admin → Products');
    console.log('   2. Create products with the missing SKUs');
    console.log('   3. For bundle products: Disable inventory tracking');
    console.log('   4. For individual products: Enable inventory tracking');
    console.log('');
  }
  
  console.log('═'.repeat(60));
}

testConfiguration().catch(error => {
  console.error('\n💥 Fatal error:', error.message);
  console.error(error);
});