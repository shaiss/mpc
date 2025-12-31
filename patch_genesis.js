
const fs = require('fs');

const genesis = JSON.parse(fs.readFileSync('decoded_genesis.json', 'utf8'));

if (!genesis.validators) {
  console.error('Patching genesis with validators...');
  genesis.validators = [];
  
  // Find accounts with locked balance in records
  for (const record of genesis.records) {
    if (record.Account) {
      const account = record.Account;
      if (account.account.locked !== "0") {
        // Scan for AccessKey
        const accessKeyRecord = genesis.records.find(r => r.AccessKey && r.AccessKey.account_id === account.account_id);
        
        if (accessKeyRecord) {
            genesis.validators.push({
                account_id: account.account_id,
                public_key: accessKeyRecord.AccessKey.public_key,
                amount: account.account.locked
            });
        }
      }
    }
  }
}

console.log(JSON.stringify(genesis, null, 2));
