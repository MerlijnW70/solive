import { type ConfigAction, type Multisig, PERMISSION } from "./layout.js";

const permissionText = (mask: number) =>
  (Object.entries(PERMISSION) as [string, number][])
    .filter(([, bit]) => (mask & bit) !== 0)
    .map(([name]) => name)
    .join(", ") || "no permissions";

export function actionText(action: ConfigAction, multisig: Multisig): string {
  switch (action.__kind) {
    case "AddMember":
      return `Adds member ${action.newMember.key} with ${permissionText(action.newMember.permissions.mask)}`;
    case "RemoveMember":
      return `Removes member ${action.oldMember}`;
    case "ChangeThreshold":
      return `Changes the threshold from ${multisig.threshold} to ${action.newThreshold}`;
    case "SetTimeLock":
      return `Changes the time lock from ${multisig.timeLock} to ${action.newTimeLock} seconds`;
    case "AddSpendingLimit":
      return `Adds spending limit ${action.createKey}: ${action.members.join(", ") || "no member"} may move ${action.amount} of mint ${action.mint} from vault ${action.vaultIndex} ${action.period.__kind === "OneTime" ? "once" : `every ${action.period.__kind.toLowerCase()}`}, to ${action.destinations.join(", ") || "any address"}, without a proposal`;
    case "RemoveSpendingLimit":
      return `Removes spending limit ${action.spendingLimit}`;
    case "SetRentCollector":
      return action.newRentCollector === null ? "Stops collecting the rent of closed transactions" : `Sends the rent of closed transactions to ${action.newRentCollector}`;
  }
}

export function afterConfig(actions: ConfigAction[], multisig: Multisig): string {
  let members = multisig.members.map((m) => m.key);
  let threshold = multisig.threshold;
  let timeLock = multisig.timeLock;
  for (const action of actions) {
    if (action.__kind === "AddMember") {
      members = [...members, action.newMember.key];
    } else if (action.__kind === "RemoveMember") {
      members = members.filter((m) => m !== action.oldMember);
    } else if (action.__kind === "ChangeThreshold") {
      threshold = action.newThreshold;
    } else if (action.__kind === "SetTimeLock") {
      timeLock = action.newTimeLock;
    }
  }
  return `After it runs: members ${members.join(", ")}; threshold ${threshold} of ${members.length}; time lock ${timeLock} seconds`;
}
