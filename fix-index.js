/* ============================================================
   fix-index.js — One-time index fix for MediCore
   
   RUN KARO:  node fix-index.js
   
   Ye script purana broken index drop karega aur naya
   sahi index banayega. Ek baar chalao, phir delete karo.
   ============================================================ */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, 'server', '.env') });

const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('\n❌  MONGODB_URI nahi mila .env file mein!');
  console.error('   Apna MONGODB_URI yahan directly daalo:');
  console.error('   const MONGODB_URI = "mongodb://localhost:27017/test"\n');
  process.exit(1);
}

async function fixIndex() {
  try {
    console.log('\n🔄  MongoDB se connect ho raha hoon...');
    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    console.log('✅  Connected!\n');

    const db = mongoose.connection.db;
    const collection = db.collection('users');

    // Pehle dekho kaunse indexes hain
    const existingIndexes = await collection.indexes();
    console.log('📋  Current indexes:');
    existingIndexes.forEach(idx => {
      console.log('   -', idx.name, JSON.stringify(idx.key));
    });
    console.log('');

    // Purana broken index drop karo
    const brokenIndexName = 'email_1_clinicId_1';
    const brokenExists = existingIndexes.find(idx => idx.name === brokenIndexName);

    if (brokenExists) {
      console.log(`🗑️   Purana broken index drop kar raha hoon: "${brokenIndexName}"...`);
      await collection.dropIndex(brokenIndexName);
      console.log('✅  Purana index delete ho gaya!\n');
    } else {
      console.log(`ℹ️   "${brokenIndexName}" already nahi hai — skip.\n`);
    }

    // Naya sahi index banao (sirf agar email field exist kare)
    console.log('🔨  Naya sahi index bana raha hoon (sirf real emails ke liye)...');
    await collection.createIndex(
      { email: 1, clinicId: 1 },
      {
        unique: true,
        partialFilterExpression: { email: { $type: 'string' } },
        name: 'email_1_clinicId_1',
      }
    );
    console.log('✅  Naya index ban gaya!\n');

    // username index bhi check karo
    const usernameIndexName = 'username_1_clinicId_1';
    const usernameExists = existingIndexes.find(idx => idx.name === usernameIndexName);
    if (!usernameExists) {
      console.log('🔨  Username index bana raha hoon...');
      await collection.createIndex(
        { username: 1, clinicId: 1 },
        {
          unique: true,
          partialFilterExpression: { username: { $type: 'string' } },
          name: 'username_1_clinicId_1',
        }
      );
      console.log('✅  Username index ban gaya!\n');
    } else {
      console.log('✅  Username index already sahi hai.\n');
    }

    // Final index list dikhao
    const finalIndexes = await collection.indexes();
    console.log('📋  Final indexes (ab ke baad):');
    finalIndexes.forEach(idx => {
      console.log('   -', idx.name, JSON.stringify(idx.key));
    });

    console.log('\n🎉  Fix complete! Ab server restart karo:\n');
    console.log('   node server/server.js\n');
    console.log('   Phir Settings > Staff > Add Staff try karo — error nahi aayega!\n');

  } catch (err) {
    console.error('\n❌  Error aaya:', err.message);
    if (err.message.includes('ECONNREFUSED')) {
      console.error('   MongoDB chal nahi raha — pehle MongoDB start karo.\n');
    }
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

fixIndex();
