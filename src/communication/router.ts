import {getDatabase} from "../storage/database.js";
import {DeliveryRepository,type CapturedMessage,type DeliveryKind} from "../storage/repositories/delivery-repository.js";
// Mention parsers and commit-time captured-target router.
// Does NOT directly call activateAgent — uses injected callbacks for decoupling.

import { onMessage } from "./message-bus.js";
import { logger } from "../foundation/logger.js";
import type { RoomMemberRecord } from "../shared/types.js";
import { stripCodeSegments } from "../shared/mention-text.js";

/** Match literal current roster names, longest first (Unicode and spaces included). */
function rosterMentions(content: string, names: string[], marker: "@" | "!"): string[] {
  const plain = stripCodeSegments(content);
  const candidates = [...new Set(names)].filter(Boolean).sort((a, b) => b.length - a.length);
  const result: string[] = [];
  for (let i = 0; i < plain.length; i++) {
    if (plain[i] !== marker) continue;
    if (marker === "!" && i > 0 && /[\p{L}\p{N}_!]/u.test(plain[i - 1])) continue;
    const name = candidates.find(name => {
      // The marker must be outside code. A legal literal name may itself contain backticks.
      if (!content.startsWith(name, i + 1)) return false;
      const next = content[i + 1 + name.length];
      return !next || !/[\p{L}\p{N}\p{M}_.-]/u.test(next);
    });
    if (name) { result.push(name); i += name.length; }
  }
  return [...new Set(result)];
}

/** Parse current exact @names; code segments are never commands. */
export function parseMentions(content: string, roomMembers: string[]): string[] {
  const found = rosterMentions(content, [...roomMembers, "all"], "@");
  return found.includes("all") ? ["all"] : found;
}

export function parseMentionMemberIds(content: string, roomMembers: RoomMemberRecord[]): string[] {
  const names = parseMentions(content, roomMembers.map((member) => member.name));
  if (names.includes("all")) return roomMembers.map((member) => member.id);
  return names
    .map((name) => roomMembers.find((member) => member.name === name)?.id)
    .filter((id): id is string => Boolean(id));
}

// -- Urgent `!name` gesture (fish 2026-08-04: interrupt + immediate response) --

/**
 * Parse urgent `!name` gestures. Same membership rule as @ (exact room-member
 * name) plus an explicit left boundary — the `!` must not be glued to a word
 * char or another `!` — so "Hello!pm" and "wow!!" never fire. Full-width
 * Chinese `！` is a different codepoint and never matches. `!all` is NOT
 * supported (interrupting the whole room is not a thing).
 */
export function parseUrgentMentions(content: string, roomMembers: string[]): string[] {
  return rosterMentions(content, roomMembers.filter(name => name !== "all"), "!");
}

export function parseUrgentMentionMemberIds(content: string, roomMembers: RoomMemberRecord[]): string[] {
  const names = parseUrgentMentions(content, roomMembers.map((member) => member.name));
  return names
    .map((name) => roomMembers.find((member) => member.name === name)?.id)
    .filter((id): id is string => Boolean(id));
}

/** Immutable message context handed to runtime admission; no late name/@all lookup. */
export interface MentionActivationCtx {
  capture: CapturedMessage;
  deliveryKind: DeliveryKind;
  needResponse?: string[];
  needResponseMemberIds?: string[];
  senderName: string;
  senderOrigin: CapturedMessage["snapshot"]["origin"];
}
export interface RouterHandlers {
  mention(scopeId:string,actorKey:string,context:MentionActivationCtx):void;
  urgent?(scopeId:string,actorKey:string,context:MentionActivationCtx):void;
}

export function initRouter(handlers:RouterHandlers):()=>void {
  return onMessage((scopeId,message)=>{
    const capture=new DeliveryRepository(getDatabase()).getCapture(scopeId,message.id);
    if(!capture)throw new Error(`Missing durable routing capture: ${scopeId}/${message.id}`);
    const snapshot=capture.snapshot;
    if(snapshot.messageType!=="chat")return;
    for(const kind of ["ordinary","urgent","dm"] as const){
      for(const target of snapshot.targets[kind]){
        const context:MentionActivationCtx={
          capture:structuredClone(capture),deliveryKind:kind,senderName:String(snapshot.message.sender),senderOrigin:snapshot.origin,
          ...(snapshot.needResponse===null?{}:{needResponse:snapshot.needResponse.length?undefined:[],needResponseMemberIds:snapshot.needResponse.map(actor=>actor.actorKey)}),
        };
        logger.info("router","routeCapturedMessage",{scopeId,messageId:message.id,target:target.actorKey,kind});
        if(kind==="urgent"&&handlers.urgent)handlers.urgent(scopeId,target.actorKey,context);
        else handlers.mention(scopeId,target.actorKey,context);
      }
    }
  });
}
