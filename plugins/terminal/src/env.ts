// A host is an environment, `env://NAME`, in every `env.*` and `terminals.*` call and answer (rookery#42
// settles the forms: the server takes `env://NAME` or a bare name, and always answers `env://NAME`). Crow
// sends the URI form everywhere and shows the bare name.

/** `env://studio` or `studio` as the bare name. */
export function envName(env: string): string {
  return env.replace(/^env:\/\//, "")
}

/** A host as `env://NAME`, from either form. */
export function envUri(env: string): string {
  return `env://${envName(env)}`
}
