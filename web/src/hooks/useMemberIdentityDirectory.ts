import { useEffect } from "react";
import { getMemberIdentities } from "../api/client";
import { clearCurrentMemberNames, getMemberProfileRevision, seedCurrentMemberNames } from "./useMemberProfileRevision";

/** One shared directory per signed-in Layout; no per-message/profile lookups. */
export function useMemberIdentityDirectory(connected: boolean): void {
  useEffect(() => () => clearCurrentMemberNames(), []);
  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      const revision = getMemberProfileRevision();
      try {
        const members = await getMemberIdentities(controller.signal);
        if (!controller.signal.aborted) seedCurrentMemberNames(members, revision);
      } catch (error) {
        if (!controller.signal.aborted) console.warn("Unable to refresh member names", error);
      } finally { loading = false; }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 30_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [connected]);
}
