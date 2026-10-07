import type { TaskConversationItem } from "../shared/taskConversationTypes";

type CommandItem = Extract<TaskConversationItem, { kind: "command" }>;

export type ConversationItemGroup =
  | { kind: "item"; key: string; item: TaskConversationItem }
  | { kind: "commands"; key: string; items: CommandItem[] };

// Keep message order intact: only adjacent commands without an intervening reply form a group.
export function groupConversationItems(items: TaskConversationItem[]): ConversationItemGroup[] {
  const groups: ConversationItemGroup[] = [];
  for (let index = 0; index < items.length;) {
    const item = items[index];
    if (item.kind !== "command") {
      groups.push({ kind: "item", key: item.id, item });
      index += 1;
      continue;
    }
    const commands: CommandItem[] = [item];
    index += 1;
    while (items[index]?.kind === "command") {
      commands.push(items[index] as CommandItem);
      index += 1;
    }
    groups.push(commands.length > 1
      ? { kind: "commands", key: commands[0].id, items: commands }
      : { kind: "item", key: item.id, item });
  }
  return groups;
}
