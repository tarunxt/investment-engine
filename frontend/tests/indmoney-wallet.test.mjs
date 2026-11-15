import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverIndmoneyWallet} from '../lib/indmoneyWallet.ts';
test('recover the saved USD header and preserve existing wallet values',()=>{
  const snapshot={wallet_balance:null,raw_text:'My Portfolio\n\n$1,234.56\nAdd money\nCurrent Value\n$9,999.99'};
  assert.equal(recoverIndmoneyWallet(snapshot).wallet_balance,1234.56);
  assert.equal(recoverIndmoneyWallet({...snapshot,wallet_balance:0}).wallet_balance,0);
  assert.equal(recoverIndmoneyWallet({...snapshot,raw_text:'Buying power\n$123.45\nAdd money\nCurrent Value'}).wallet_balance,null);
  assert.equal(snapshot.wallet_balance,null);
});
