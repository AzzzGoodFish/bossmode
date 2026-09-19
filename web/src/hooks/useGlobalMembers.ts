import { useMemberProfileRevision } from "./useMemberProfileRevision";
/**
 * useGlobalMembers — contacts as a memberId → ContactEntry map (0.20).
 *
 * Rooms compose their member lists from room.memberIds + this map;
 * the legacy room.roomMembers record array is being removed (G3 debt ②).
 */
import { useEffect, useState } from "react";
import { getContacts, type ContactEntry } from "../api/client";

export function useGlobalMembers(): Map<string, ContactEntry> {
  const profileRevision = useMemberProfileRevision();
  const [map, setMap] = useState<Map<string, ContactEntry>>(new Map());
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getContacts()
        .then((r) => { if (!cancelled) setMap(new Map(r.contacts.map((c) => [c.memberId, c]))); })
        .catch(() => {});
    load();
    const t = window.setInterval(load, 30_000);
    return () => { cancelled = true; window.clearInterval(t); };
  }, [profileRevision]);
  return map;
}
