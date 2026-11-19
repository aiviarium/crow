// One field of an action's or a provisioner's arguments, as the server declares it: a choice of a few
// values, a yes or no, several lines, a size, or any text, with the server's why for one that cannot change.
import { Select, Switch, TextArea, TextField } from "@aiviarium/nocturne"
import { type JSX, Show } from "solid-js"
import { argumentLabel, isBooleanArgument, isOn, switchValues } from "./provisionApi"
import type { Argument } from "./types"

export function ArgumentField(props: {
  argument: Argument
  value: string
  error?: string
  idPrefix?: string
  onChange(value: string): void
}): JSX.Element {
  const label = () => argumentLabel(props.argument)
  const values = () => props.argument.values ?? []
  const fixed = () => !!props.argument.fixed
  const help = () => props.argument.fixed || props.argument.help || undefined
  const id = () => `${props.idPrefix ?? "argument"}-${props.argument.name}`
  return (
    <Show
      when={!isBooleanArgument(props.argument)}
      fallback={
        <div class="fleet-switch-field" data-argument={props.argument.name}>
          <Switch
            label={label()}
            checked={isOn(props.value)}
            disabled={fixed()}
            onChange={(on) => {
              const values_ = switchValues(props.argument)
              props.onChange(on ? values_.on : values_.off)
            }}
          />
          <Show when={help()}>{(text) => <span class="nc-meta">{text()}</span>}</Show>
        </div>
      }
    >
      <Show
        when={values().length > 0}
        fallback={
          <Show
            when={props.argument.kind === "text"}
            fallback={
              <TextField
                id={id()}
                label={props.argument.required ? `${label()} *` : label()}
                help={help()}
                error={props.error}
                mono
                type={props.argument.secret ? "password" : "text"}
                autocomplete={props.argument.secret ? "off" : undefined}
                disabled={fixed()}
                value={props.value}
                onInput={(e) => props.onChange(e.currentTarget.value)}
              />
            }
          >
            <TextArea
              id={id()}
              label={props.argument.required ? `${label()} *` : label()}
              help={help()}
              error={props.error}
              disabled={fixed()}
              value={props.value}
              onInput={(e) => props.onChange(e.currentTarget.value)}
            />
          </Show>
        }
      >
        <Select
          label={props.argument.required ? `${label()} *` : label()}
          help={help()}
          error={props.error}
          options={values().map((value) => ({ value, label: value || "(none)" }))}
          value={props.value}
          disabled={fixed()}
          onChange={(value) => props.onChange(value)}
        />
      </Show>
    </Show>
  )
}

/** A run of argument fields, in the order the server declared them. */
export function ArgumentFields(props: {
  arguments: Argument[]
  values: Record<string, string>
  errors?: Record<string, string>
  idPrefix?: string
  onChange(name: string, value: string): void
}): JSX.Element {
  return (
    <>
      {props.arguments.map((argument) => (
        <ArgumentField
          argument={argument}
          value={props.values[argument.name] ?? ""}
          error={props.errors?.[argument.name]}
          idPrefix={props.idPrefix}
          onChange={(value) => props.onChange(argument.name, value)}
        />
      ))}
    </>
  )
}
