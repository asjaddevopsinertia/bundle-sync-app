// update-parent-bundle-sku.js
require('dotenv').config();
const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || 'shopify-bundles';

async function updateParentBundleSku() {
  let mongoClient;

  try {
    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║       UPDATE parentBundleSku Field                     ║');
    console.log('╚════════════════════════════════════════════════════════╝');
    
    console.log('\n🔌 Connecting to MongoDB...');
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    const db = mongoClient.db(DB_NAME);
    console.log('✅ Connected to MongoDB');

    const componentSales = db.collection('componentSales');

    // Step 1: Find all records that need updating
    console.log('\n📊 Analyzing componentSales collection...');
    
    const totalRecords = await componentSales.countDocuments({});
    console.log(`   Total records: ${totalRecords}`);

    const recordsWithParentBundleSku = await componentSales.countDocuments({
      parentBundleSku: { $exists: true }
    });
    console.log(`   Records with parentBundleSku: ${recordsWithParentBundleSku}`);

    const recordsNeedingUpdate = totalRecords - recordsWithParentBundleSku;
    console.log(`   Records needing update: ${recordsNeedingUpdate}`);

    if (recordsNeedingUpdate === 0) {
      console.log('\n✅ All records already have parentBundleSku field!');
      return;
    }

    console.log('\n⚙️  Updating records...');

    // Step 2: Update records where saleType is 'bundle' but parentBundleSku doesn't exist
    // Set parentBundleSku = bundleSku
    const bundleUpdateResult = await componentSales.updateMany(
      {
        saleType: 'bundle',
        parentBundleSku: { $exists: false }
      },
      {
        $set: {
          parentBundleSku: '$bundleSku' // This won't work directly, need to use aggregation pipeline
        }
      }
    );

    // MongoDB doesn't support field references in regular updateMany, so we need to do it differently:
    console.log('   Step 1: Updating bundle sales...');
    
    const bundleSales = await componentSales.find({
      saleType: 'bundle',
      parentBundleSku: { $exists: false }
    }).toArray();

    let bundleUpdateCount = 0;
    for (const record of bundleSales) {
      await componentSales.updateOne(
        { _id: record._id },
        {
          $set: {
            parentBundleSku: record.bundleSku,
            updatedAt: new Date()
          }
        }
      );
      bundleUpdateCount++;
      
      if (bundleUpdateCount % 100 === 0) {
        console.log(`      Updated ${bundleUpdateCount}/${bundleSales.length} bundle records...`);
      }
    }
    console.log(`   ✅ Updated ${bundleUpdateCount} bundle sale records`);

    // Step 3: Update records where saleType is 'direct'
    // Set parentBundleSku = null
    console.log('   Step 2: Updating direct sales...');
    
    const directUpdateResult = await componentSales.updateMany(
      {
        saleType: 'direct',
        parentBundleSku: { $exists: false }
      },
      {
        $set: {
          parentBundleSku: null,
          updatedAt: new Date()
        }
      }
    );
    console.log(`   ✅ Updated ${directUpdateResult.modifiedCount} direct sale records`);

    // Step 4: Handle any records without saleType (shouldn't exist, but just in case)
    const noSaleTypeCount = await componentSales.countDocuments({
      saleType: { $exists: false },
      parentBundleSku: { $exists: false }
    });

    if (noSaleTypeCount > 0) {
      console.log(`   ⚠️  Found ${noSaleTypeCount} records without saleType field`);
      const noSaleTypeResult = await componentSales.updateMany(
        {
          saleType: { $exists: false },
          parentBundleSku: { $exists: false }
        },
        {
          $set: {
            parentBundleSku: null,
            updatedAt: new Date()
          }
        }
      );
      console.log(`   ✅ Updated ${noSaleTypeResult.modifiedCount} records without saleType`);
    }

    // Step 5: Verify the update
    console.log('\n📊 Verification:');
    const finalRecordsWithParentBundleSku = await componentSales.countDocuments({
      parentBundleSku: { $exists: true }
    });
    console.log(`   Records with parentBundleSku: ${finalRecordsWithParentBundleSku}/${totalRecords}`);

    // Show some examples
    console.log('\n📝 Sample records after update:');
    
    const sampleBundle = await componentSales.findOne({
      saleType: 'bundle',
      parentBundleSku: { $exists: true }
    });
    
    if (sampleBundle) {
      console.log('\n   Bundle sale example:');
      console.log(`      SKU: ${sampleBundle.componentSku}`);
      console.log(`      saleType: ${sampleBundle.saleType}`);
      console.log(`      bundleSku: ${sampleBundle.bundleSku}`);
      console.log(`      parentBundleSku: ${sampleBundle.parentBundleSku}`);
    }

    const sampleDirect = await componentSales.findOne({
      saleType: 'direct',
      parentBundleSku: { $exists: true }
    });
    
    if (sampleDirect) {
      console.log('\n   Direct sale example:');
      console.log(`      SKU: ${sampleDirect.componentSku}`);
      console.log(`      saleType: ${sampleDirect.saleType}`);
      console.log(`      bundleSku: ${sampleDirect.bundleSku}`);
      console.log(`      parentBundleSku: ${sampleDirect.parentBundleSku}`);
    }

    // Show fruit bundle breakdown
    console.log('\n🍊 Fruit bundle breakdown:');
    
    const fruit5LBCount = await componentSales.countDocuments({
      parentBundleSku: { $regex: /05LB/ },
      componentSku: { $regex: /FRT/ }
    });
    
    const fruit10LBCount = await componentSales.countDocuments({
      parentBundleSku: { $regex: /10LB/ },
      componentSku: { $regex: /FRT/ }
    });

    console.log(`   5LB fruit bundle sales: ${fruit5LBCount} records`);
    console.log(`   10LB fruit bundle sales: ${fruit10LBCount} records`);

    console.log('\n✅ Update Complete!');
    console.log('\n💡 Next steps:');
    console.log('   1. Restart your backend server to use the updated API endpoints');
    console.log('   2. The frontend will now show separate 5LB and 10LB columns');
    console.log('   3. No need to reimport all data!');

  } catch (error) {
    console.error('\n❌ Update failed:', error);
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
  console.log('\n🚀 Starting parentBundleSku update...\n');
  console.log('⏳ Starting in 3 seconds... Press Ctrl+C to cancel\n');

  setTimeout(() => {
    updateParentBundleSku()
      .then(() => {
        console.log('\n🎉 All done!');
        process.exit(0);
      })
      .catch(err => {
        console.error(err);
        process.exit(1);
      });
  }, 3000);
}

module.exports = { updateParentBundleSku };