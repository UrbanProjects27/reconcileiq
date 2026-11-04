import database from '../../lib/database.js';
import onedriveModule from '../../lib/onedrive.js';
import syncModule from '../../lib/auto-sync.js';
import {randomUUID} from 'node:crypto';
export default async request=>{
  let input;try{input=await request.json();}catch{return;}
  if(!syncModule.verifyRun(input?.id,input?.signature,process.env.ONEDRIVE_TOKEN_KEY))return;
  const db=await database.openDatabase();
  try{
    const audit=async(query,user,action,detail)=>query('INSERT INTO audit_events(id,actor_id,actor_name,action,detail,created_at) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),user.id,user.name,action,JSON.stringify(detail),new Date().toISOString()]);
    const onedrive=onedriveModule.createOneDrive({db,audit});
    await syncModule.createAutoSync({db,onedrive,audit}).run(input.id);
  }finally{await db.close();}
};
export const config={background:true};
