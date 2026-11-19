// The keyboard shortcuts sheet (`?` in a project's views, or the palette's "Projects keyboard shortcuts").
import { Dialog, Kbd } from "@aiviarium/nocturne"
import { createSignal, For } from "solid-js"

const [open, setOpen] = createSignal(false)
export const openShortcuts = () => setOpen(true)

const GROUPS: Array<{ title: string; keys: Array<[string[], string]> }> = [
  {
    title: "Anywhere",
    keys: [
      [["Ctrl", "Alt", "N"], "New issue"],
      [["Ctrl", "K"], "Command palette (type “issue” for project commands)"],
    ],
  },
  {
    title: "Lists and boards",
    keys: [
      [["C"], "New issue in this project"],
      [["J"], "Next issue (or ↓)"],
      [["K"], "Previous issue (or ↑)"],
      [["H"], "Column to the left (board, or ←)"],
      [["L"], "Column to the right (board, or →); labels in a list"],
      [["X"], "Select the issue"],
      [["Shift", "J/K"], "Extend the selection"],
      [["Ctrl", "A"], "Select everything shown"],
      [["Enter"], "Open the issue"],
      [["Esc"], "Clear the selection"],
      [["V"], "Switch between list and board"],
      [["/"], "Filter with the query bar"],
      [["F"], "Add a filter"],
      [["?"], "This sheet"],
    ],
  },
  {
    title: "The selection, or the issue under the cursor",
    keys: [
      [["S"], "Change the state"],
      [["A"], "Assign"],
      [["I"], "Assign to me"],
      [["L"], "Change the labels (Shift L on a board)"],
      [["P"], "Set the priority (0 to 4 in the menu)"],
      [["E"], "Estimate"],
      [["Shift", "C"], "Add to a cycle"],
      [["Ctrl", "⌫"], "Move to the trash"],
    ],
  },
  {
    title: "An issue",
    keys: [
      [["S", "A", "L", "P"], "Change its state, assignee, labels, priority"],
      [["Ctrl", "Enter"], "Send a comment"],
      [["Esc"], "Back to the list"],
    ],
  },
]

export function ShortcutsHost() {
  return (
    <Dialog
      open={open()}
      onClose={() => setOpen(false)}
      title="Keyboard shortcuts"
      size="md"
      data-part="shortcuts"
    >
      <div class="projects__shortcuts">
        <For each={GROUPS}>
          {(g) => (
            <section>
              <h3 class="section projects__shortcuts-title">{g.title}</h3>
              <For each={g.keys}>
                {([keys, what]) => (
                  <div class="projects__shortcut">
                    <span class="projects__shortcut-keys">
                      <For each={keys}>{(k) => <Kbd>{k}</Kbd>}</For>
                    </span>
                    <span>{what}</span>
                  </div>
                )}
              </For>
            </section>
          )}
        </For>
      </div>
    </Dialog>
  )
}
