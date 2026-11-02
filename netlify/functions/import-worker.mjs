import database from '../../lib/database.js';
import onedriveModule from '../../lib/onedrive.js';
import bulkModule from '../../lib/bulk-import.js';
export default async request=>{
  let input;try{input=await request.json();}catch{return;}
  if(!bulkModule.verifySignature(input?.id,input?.signature,process.env.ONEDRIVE_TOKEN_KEY))return;
  const db=await database.openDatabase();
  try{
    const onedrive=onedriveModule.createOneDrive({db,audit:async()=>{}});
    await bulkModule.createBulkImport({db,onedrive}).run(input.id);
  }finally{await db.close();}
};
export const config={background:true};
