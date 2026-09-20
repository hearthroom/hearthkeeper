export const requiredBotPermissions =
  (1n << 10n) |
  (1n << 11n) |
  (1n << 14n) |
  (1n << 16n) |
  (1n << 34n) |
  (1n << 38n);
export function checkForumAccess(input: {
  guildId: string;
  forumGuildId: string;
  type: number;
  botId: string;
  staffRoles: string[];
  botPermissions: bigint;
  overwrites: { id: string; type: number; allow: string; deny: string }[];
}) {
  if (
    input.type !== 15 ||
    input.guildId !== input.forumGuildId ||
    !input.staffRoles.length ||
    (input.botPermissions & requiredBotPermissions) !== requiredBotPermissions
  )
    return false;
  const everyone = input.overwrites.find(
    (o) => o.id === input.guildId && o.type === 0,
  );
  if (
    !everyone ||
    (BigInt(everyone.deny) & 1024n) === 0n ||
    (BigInt(everyone.allow) & 1024n) !== 0n
  )
    return false;
  return input.overwrites.every(
    (o) =>
      (BigInt(o.allow) & 1024n) === 0n ||
      (o.type === 0 && input.staffRoles.includes(o.id)) ||
      (o.type === 1 && o.id === input.botId),
  );
}
