import { useCallback, useEffect, useRef, useState } from 'react';
import { getToken } from '../api/client';
import type { WsEvent } from '../hooks/useWebSocket';
/** One socket per signed-in app; subscriptions and listeners survive reconnects. */
export function useConnection(scopes:string[], onEvent:(event:WsEvent)=>void) {
  const [state,setState]=useState<'connecting'|'online'|'offline'>('connecting');
  const [attempt,setAttempt]=useState(0), socket=useRef<WebSocket|null>(null), wanted=useRef(scopes), callback=useRef(onEvent);
  wanted.current=scopes;callback.current=onEvent;
  useEffect(()=>{
    let disposed=false, timer:ReturnType<typeof setTimeout>|undefined, retries=0, ws:WebSocket;
    const open=()=>{if(disposed||!getToken())return;setState('connecting');ws=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/ws?token=${encodeURIComponent(getToken()!)}`);socket.current=ws;
      ws.onopen=()=>{if(disposed){ws.close();return;}retries=0;setState('online');for(const scope of wanted.current)ws.send(JSON.stringify({type:'subscribe:room',roomId:scope.startsWith('room:')?scope.slice(5):scope}));};
      ws.onmessage=e=>{if(disposed)return;try{callback.current(JSON.parse(e.data));}catch{/* malformed server frame */}};
      ws.onerror=()=>{};
      ws.onclose=()=>{if(disposed)return;setState('offline');if(retries<5)timer=setTimeout(open,Math.min(1000*2**retries++,10000));};
    };
    open();return()=>{disposed=true;clearTimeout(timer);ws?.close();socket.current=null;};
  },[attempt]);
  const scopeKey=scopes.join('|');
  useEffect(()=>{const ws=socket.current;if(ws?.readyState!==WebSocket.OPEN)return;for(const scope of scopes)ws.send(JSON.stringify({type:'subscribe:room',roomId:scope.startsWith('room:')?scope.slice(5):scope}));},[scopeKey,state]);
  return {state,reconnect:useCallback(()=>setAttempt(v=>v+1),[])};
}
