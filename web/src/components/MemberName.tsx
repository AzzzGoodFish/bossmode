import { useCurrentMemberName } from "../hooks/useMemberProfileRevision";

/** Text only, usable in author spans and native option elements. */
export function MemberName({ memberId, recordedName }: {memberId?: string; recordedName: string}) {
  return useCurrentMemberName(memberId, recordedName);
}
