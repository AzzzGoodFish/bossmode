import type { Database } from "../database.js";
import type { McpServerAvailability } from "../../kernel/types.js";
import { defined, objectJson, parseObject } from "../../kernel/json.js";
export type McpStatusCache = Record<string, McpServerAvailability & { configHash?: string }>;

type Field = readonly [key: string, column: string, type: "string" | "number" | "boolean"];
const serverFields: readonly Field[] = [
  ["command","command","string"], ["url","url","string"], ["cwd","cwd","string"],
  ["bearerToken","bearer_token","string"], ["bearerTokenEnv","bearer_token_env","string"], ["lifecycle","lifecycle","string"],
  ["idleTimeout","idle_timeout","number"], ["requestTimeoutMs","request_timeout_ms","number"],
  ["exposeResources","expose_resources","boolean"], ["debug","debug","boolean"],
];
const settingFields: readonly Field[] = [
  ["toolPrefix","tool_prefix","string"], ["idleTimeout","idle_timeout","number"], ["requestTimeoutMs","request_timeout_ms","number"],
  ["directTools","direct_tools","boolean"], ["disableProxyTool","disable_proxy_tool","boolean"], ["autoAuth","auto_auth","boolean"],
  ["sampling","sampling","boolean"], ["samplingAutoApprove","sampling_auto_approve","boolean"], ["elicitation","elicitation","boolean"],
  ["authRequiredMessage","auth_required_message","string"],
];
const oauthFields: readonly Field[] = [
  ["grantType","grant_type","string"], ["clientId","client_id","string"], ["clientSecret","client_secret","string"],
  ["scope","scope","string"], ["redirectUri","redirect_uri","string"], ["clientName","client_name","string"], ["clientUri","client_uri","string"],
];
function extract(source: Record<string, unknown>, fields: readonly Field[]): Record<string, unknown> {
  return Object.fromEntries(fields.map(([key,column,type]) => {
    const value=source[key]; delete source[key];
    if (value !== undefined && (typeof value !== type || type === "number" && !Number.isFinite(value))) throw new Error("Invalid MCP field");
    return [column,value === undefined ? null : type === "boolean" ? Number(value) : value];
  }));
}
function restore(row: Record<string, unknown>, fields: readonly Field[]): Record<string, unknown> {
  return defined(Object.fromEntries(fields.map(([key,column,type])=>[key,row[column] === null ? undefined : type === "boolean" ? !!row[column] : row[column]])));
}
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(v=>typeof v !== "string")) throw new Error("Invalid MCP string list");
  return value;
}

/** Internal configuration API, including secret-bearing transport and OAuth fields. */
export class McpSettingsRepository {
  constructor(private readonly db: Database, private readonly ownerId = "global") {}
  exists(): boolean { return !!this.db.get("SELECT owner_id FROM mcp_config WHERE owner_id=?",this.ownerId); }
  private insert(table: string, fields: Record<string, unknown>): void {
    // Identifiers are fixed repository constants, never configuration input.
    this.db.run(`INSERT INTO ${table} (${Object.keys(fields).join(",")}) VALUES (${Object.keys(fields).map(()=>"?").join(",")})`,...Object.values(fields));
  }
  read(): Record<string, unknown> {
    const root=this.db.get<any>("SELECT * FROM mcp_config WHERE owner_id=?",this.ownerId);
    if (!root) return {mcpServers:{}};
    const servers=Object.fromEntries(this.db.all<any>("SELECT * FROM mcp_servers WHERE owner_id=? ORDER BY position",this.ownerId).map(s=>{
      const values=this.db.all<any>("SELECT * FROM mcp_server_values WHERE owner_id=? AND server_name=?",this.ownerId,s.name);
      const args=this.db.all<{value:string}>("SELECT value FROM mcp_server_args WHERE owner_id=? AND server_name=? ORDER BY position",this.ownerId,s.name).map(a=>a.value);
      const tools=this.db.all<any>("SELECT * FROM mcp_server_tools WHERE owner_id=? AND server_name=? ORDER BY position",this.ownerId,s.name);
      const env=Object.fromEntries(values.filter(v=>v.kind==='env').map(v=>[v.name,v.value]));
      const headers=Object.fromEntries(values.filter(v=>v.kind==='headers').map(v=>[v.name,v.value]));
      const exclude=tools.filter(t=>t.kind==='exclude').map(t=>t.name);
      const oauth=this.db.get<any>("SELECT * FROM mcp_oauth_config WHERE owner_id=? AND server_name=?",this.ownerId,s.name);
      return [s.name,{
        ...parseObject(s.extension_json),...restore(s,serverFields),
        ...defined({auth:s.auth === null ? undefined : s.auth === "disabled" ? false : s.auth,
          directTools:s.direct_tools === null ? undefined : s.direct_tools === "list" ? tools.filter(t=>t.kind==='direct').map(t=>t.name) : s.direct_tools === "enabled"}),
        ...(oauth ? {oauth:oauth.enabled ? {...parseObject(oauth.extension_json),...restore(oauth,oauthFields)} : false} : {}),
        ...(args.length ? {args}:{}),...(Object.keys(env).length ? {env}:{}),...(Object.keys(headers).length ? {headers}:{}),...(exclude.length ? {excludeTools:exclude}:{}),
      }];
    }));
    const imports=this.db.all<{kind:string}>("SELECT kind FROM mcp_imports WHERE owner_id=? ORDER BY position",this.ownerId).map(r=>r.kind);
    return {
      ...parseObject(root.extension_json),mcpServers:servers,...(imports.length ? {imports}:{}),
      ...(root.settings_extension_json === null ? {} : {settings:{
        ...parseObject(root.settings_extension_json),...restore(root,settingFields),
        ...defined({outputGuard:root.output_guard === null ? undefined : root.output_guard === "custom"
          ? defined({maxBytes:root.output_guard_max_bytes,maxLines:root.output_guard_max_lines,detailsMaxBytes:root.output_guard_details_max_bytes}) : root.output_guard === "enabled"}),
      }}),
    };
  }
  importMemberConfig(memberId: string, config: Record<string, unknown>): void {
    new McpSettingsRepository(this.db,`member:${memberId}`).importConfig(config);
  }
  importConfig(config: Record<string, unknown>): void {
    const {mcpServers={},settings,imports,...extension}=config;
    objectJson(mcpServers);
    const settingsObject=settings === undefined ? {} : {...parseObject(objectJson(settings))};
    const {outputGuard}=settingsObject;delete settingsObject.outputGuard;
    const settingsColumns=extract(settingsObject,settingFields);
    const guard=typeof outputGuard === "object" && outputGuard !== null ? {...parseObject(objectJson(outputGuard))} : {};
    if (outputGuard === null || outputGuard !== undefined && typeof outputGuard !== "object" && typeof outputGuard !== "boolean") throw new Error("Invalid MCP output guard");
    const guardColumns=extract(guard,[["maxBytes","output_guard_max_bytes","number"],["maxLines","output_guard_max_lines","number"],["detailsMaxBytes","output_guard_details_max_bytes","number"]]);
    if (Object.keys(guard).length) throw new Error("Unknown MCP output guard field");
    if (imports !== undefined && !stringArray(imports).length) extension.imports=[];
    this.db.transaction(tx=>{
      tx.run("DELETE FROM mcp_config WHERE owner_id=?",this.ownerId);
      this.insert("mcp_config",{owner_id:this.ownerId,extension_json:objectJson(extension),settings_extension_json:settings === undefined ? null : objectJson(settingsObject),...settingsColumns,
        output_guard:outputGuard === undefined ? null : typeof outputGuard === "object" ? "custom" : outputGuard ? "enabled" : "disabled",...guardColumns});
      if (imports !== undefined) stringArray(imports).forEach((kind,i)=>tx.run("INSERT INTO mcp_imports VALUES (?,?,?)",this.ownerId,i,kind));
      Object.entries(mcpServers as Record<string,unknown>).forEach(([name,value],position)=>{
        const {args,env,headers,auth,directTools,excludeTools,oauth,...opaque}=parseObject(objectJson(value));
        const columns=extract(opaque,serverFields);
        if (auth !== undefined && auth !== false && auth !== "oauth" && auth !== "bearer") throw new Error("Invalid MCP auth mode");
        if (directTools !== undefined && typeof directTools !== "boolean") stringArray(directTools);
        if (args !== undefined && !stringArray(args).length) opaque.args=[];
        if (excludeTools !== undefined && !stringArray(excludeTools).length) opaque.excludeTools=[];
        for (const [kind,values] of Object.entries({env,headers})) if (values !== undefined) {
          objectJson(values);
          if (Object.values(values as object).some(v=>typeof v !== "string")) throw new Error("Invalid MCP environment or headers");
          if (!Object.keys(values as object).length) opaque[kind]={};
        }
        this.insert("mcp_servers",{owner_id:this.ownerId,name,position,...columns,auth:auth === false ? "disabled" : auth ?? null,
          direct_tools:directTools === undefined ? null : Array.isArray(directTools) ? "list" : directTools ? "enabled" : "disabled",extension_json:objectJson(opaque)});
        if (args !== undefined) stringArray(args).forEach((a,i)=>tx.run("INSERT INTO mcp_server_args VALUES (?,?,?,?)",this.ownerId,name,i,a));
        for (const [kind,values] of Object.entries({env,headers})) for (const [key,v] of Object.entries(values ?? {})) tx.run("INSERT INTO mcp_server_values VALUES (?,?,?,?,?)",this.ownerId,name,kind,key,v);
        for (const [kind,list] of [["direct",Array.isArray(directTools) ? directTools : []],["exclude",excludeTools ?? []]] as const) stringArray(list).forEach((tool,i)=>tx.run("INSERT INTO mcp_server_tools VALUES (?,?,?,?,?)",this.ownerId,name,kind,i,tool));
        if (oauth !== undefined) {
          const options=oauth === false ? {} : {...parseObject(objectJson(oauth))};
          const oauthColumns=extract(options,oauthFields);
          this.insert("mcp_oauth_config",{owner_id:this.ownerId,server_name:name,enabled:Number(oauth !== false),...oauthColumns,extension_json:objectJson(options)});
        }
      });
    });
  }
  status(): McpStatusCache {
    return Object.fromEntries(this.db.all<any>("SELECT * FROM mcp_status").map(s=>[s.server_name,{name:s.name,status:s.status,
      ...defined({checkedAt:s.checked_at,toolCount:s.tool_count,resourceCount:s.resource_count,error:s.error,configHash:s.config_hash})}]));
  }
  importStatus(cache: McpStatusCache): void {
    this.db.transaction(tx=>{
      tx.run("DELETE FROM mcp_status");
      for (const [key,s] of Object.entries(cache)) tx.run("INSERT INTO mcp_status VALUES (?,?,?,?,?,?,?,?)",key,s.name,s.status,s.checkedAt ?? null,s.toolCount ?? null,s.resourceCount ?? null,s.error ?? null,s.configHash ?? null);
    });
  }
}
