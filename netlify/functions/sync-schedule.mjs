import database from '../../lib/database.js';
import syncModule from '../../lib/auto-sync.js';
export default async()=>{
  const db=await database.openDatabase();
  try{await syncModule.createAutoSync({db}).dispatch(process.env.APP_ORIGIN || process.env.URL);}
  finally{await db.close();}
};
export const config={schedule:'*/15 * * * *'};
