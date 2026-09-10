import { allowMethod, sendError } from '../server/http.js';
import { requireUser } from '../server/supabase-rest.js';
import { processDocumentJobs } from '../server/document-service.js';
import { processNotificationJobs } from '../server/notification-service.js';

export default async function handler(req,res){
  if(!allowMethod(req,res,['POST']))return;
  try{
    await requireUser(req);
    const [documents,notifications]=await Promise.all([
      processDocumentJobs(10),
      processNotificationJobs(20)
    ]);
    return res.status(200).json({ok:true,documents,notifications});
  }catch(error){return sendError(res,error,'Lifecycle processing failed');}
}
