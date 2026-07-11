require('dotenv').config();
const axios = require('axios');

const SERVER_URL = 'http://localhost:3000';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getInventory(sku) {
  const response = await axios.get(`${SERVER_URL}/test/variant/${sku}`);
  return response.data?.inventoryQuantity || 0;
}

async function runFullTest() {
  

  try {
    
    const initialInventory = {};
    const skus = ['123', '456', '789'];
    
    for (const sku of skus) {
      const qty = await getInventory(sku);
      initialInventory[sku] = qty;
      
      await sleep(300);
    }

    
    await axios.post(`${SERVER_URL}/test/process-order`, {
      lineItems: [{ sku: '2-set', quantity: 1 }],
      action: 'reduce'
    });
    console.log('   Order processed');

    await sleep(2000);

    
    for (const sku of skus) {
      const qty = await getInventory(sku);
      const change = qty - initialInventory[sku];
      
      await sleep(300);
    }

    // console.log('\n4. Simulating refund (2x 2-set)...');
    // await axios.post(`${SERVER_URL}/test/process-order`, {
    //   lineItems: [{ sku: '2-set', quantity: 2 }],
    //   action: 'restore'
    // });
    // console.log('   Refund processed');

    await sleep(2000);

  
    let allMatch = true;
    for (const sku of skus) {
      const qty = await getInventory(sku);
      const matches = qty === initialInventory[sku];
      const status = matches ? 'MATCH' : 'MISMATCH';
      
      if (!matches) allMatch = false;
      await sleep(300);
    }

  } catch (error) {
    console.error('\nTest failed:', error.response?.data || error.message);
  }
}

runFullTest();