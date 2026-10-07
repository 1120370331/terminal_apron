import type { TaskConversationDetail } from "../../shared/taskConversationTypes.js";

interface CacheEntry { detail:TaskConversationDetail;storedAt:number;sizeBytes:number }

export class TaskConversationProjectionCache {
  private readonly entries=new Map<string,CacheEntry>();
  private readonly pending=new Map<string,Promise<TaskConversationDetail>>();
  private readonly generations=new Map<string,number>();
  constructor(private readonly options:{maxEntries?:number;ttlMs?:number;maxEntryBytes?:number;now?:()=>number}={}){}
  async get(taskId:string,threadId:string,loader:()=>Promise<TaskConversationDetail>):Promise<TaskConversationDetail>{const key=cacheKey(taskId,threadId),now=this.now();const cached=this.entries.get(key);if(cached&&now-cached.storedAt<=this.ttlMs){this.entries.delete(key);this.entries.set(key,cached);return cached.detail;}if(cached)this.entries.delete(key);const existing=this.pending.get(key);if(existing)return existing;const generation=this.generations.get(key)??0;const loading=loader().then((detail)=>{const sizeBytes=Buffer.byteLength(JSON.stringify(detail));if((this.generations.get(key)??0)===generation&&sizeBytes<=this.maxEntryBytes){this.entries.set(key,{detail,storedAt:this.now(),sizeBytes});this.trim();}return detail;}).finally(()=>{if(this.pending.get(key)===loading)this.pending.delete(key);});this.pending.set(key,loading);return loading;}
  invalidate(taskId:string,threadId:string):void{this.invalidateKey(cacheKey(taskId,threadId));}
  invalidateThread(threadId:string):void{for(const key of new Set([...this.entries.keys(),...this.pending.keys(),...this.generations.keys()]))if(key.endsWith(`\0${threadId}`))this.invalidateKey(key);}
  clear():void{for(const key of new Set([...this.entries.keys(),...this.pending.keys(),...this.generations.keys()]))this.invalidateKey(key);this.entries.clear();this.pending.clear();}
  stats():{entries:number;bytes:number}{return{entries:this.entries.size,bytes:[...this.entries.values()].reduce((sum,entry)=>sum+entry.sizeBytes,0)};}
  private trim():void{while(this.entries.size>this.maxEntries)this.entries.delete(this.entries.keys().next().value as string);}
  private invalidateKey(key:string):void{this.entries.delete(key);this.pending.delete(key);this.generations.set(key,(this.generations.get(key)??0)+1);}
  private now():number{return(this.options.now??Date.now)();}
  private get maxEntries():number{return this.options.maxEntries??20;}
  private get ttlMs():number{return this.options.ttlMs??30_000;}
  private get maxEntryBytes():number{return this.options.maxEntryBytes??8*1024*1024;}
}
function cacheKey(taskId:string,threadId:string):string{return`${taskId}\0${threadId}`;}
