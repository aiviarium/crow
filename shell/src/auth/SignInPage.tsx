// Sign-in page supporting OIDC redirect (with readiness polling), local-account one-time sign-in
// links, development sign-in when offered by Rookery, and ended-session overlays.
import { Button, Callout, Frame, TextField } from "@aiviarium/nocturne"
import { devLoginUrl, fetchSession, loginUrl, parseSignInLink, type SignInOptions } from "@rookery/client"
import { createSignal, For, type JSX, onCleanup, Show } from "solid-js"
import { BrandMark } from "../app/BrandMark"
import type { ShellApp } from "../app/state"
import "./auth.css"

const DEV_USERS = ["dev", "ann", "bo", "admin"]

export interface SignInPageProps {
  app: ShellApp
  options: SignInOptions
  /** The session ended while the shell was open; renders as an overlay over the mounted shell. */
  ended?: boolean
}

export function SignInPage(props: SignInPageProps): JSX.Element {
  const [options, setOptions] = createSignal<SignInOptions>(props.options)
  const [devUser, setDevUser] = createSignal("dev")
  const [linkInput, setLinkInput] = createSignal("")
  const [linkError, setLinkError] = createSignal<string | undefined>(undefined)

  const sso = () => options().sso
  const here = () => {
    const cur = props.app.currentUrl()
    return cur.pathname + cur.search
  }

  // Poll /auth/session while the identity provider is temporarily unreachable.
  const poll = setInterval(async () => {
    if (sso()?.ready !== false) return
    const check = await fetchSession({ baseUrl: props.app.baseUrl })
    if (!check.authenticated && !check.unreachable) {
      setOptions(check.options)
    }
  }, 3000)
  onCleanup(() => clearInterval(poll))

  const submitLocalLink = (e: SubmitEvent) => {
    e.preventDefault()
    const origin = props.app.baseUrl ?? (typeof location !== "undefined" ? location.origin : undefined)
    const target = parseSignInLink(linkInput(), origin)
    if (!target) {
      setLinkError("Paste a valid sign-in link or code from this server.")
      return
    }
    setLinkError(undefined)
    let base = props.app.baseUrl ?? ""
    while (base.endsWith("/")) base = base.slice(0, -1)
    const dest = base ? `${base}${target}` : target
    props.app.goExternal(dest)
  }

  return (
    <main class="crow-signin" data-part="signin" data-state={props.ended ? "ended" : undefined}>
      <Frame class="crow-signin__card">
        <div class="nc-stack crow-signin__form">
          <span class="crow-sidebar__workspace heading">
            <BrandMark />
            {props.ended ? "Your session has ended" : "Sign in to Crow"}
          </span>

          <Show when={props.ended}>
            <p class="body nc-muted">
              You were signed out of this device. Sign in again to continue where you left off.
            </p>
          </Show>

          <Show when={sso()}>
            {(s) => (
              <>
                <Show when={!s().ready}>
                  <Callout tone="warning" data-part="signin-unavailable">
                    {s().name} is not reachable right now. This page retries automatically.
                  </Callout>
                </Show>
                <Button
                  variant="primary"
                  size="lg"
                  href={loginUrl(here(), props.app.baseUrl)}
                  disabled={!s().ready}
                  data-part="signin-sso"
                  onClick={(e) => {
                    e.preventDefault()
                    if (s().ready) props.app.goExternal(loginUrl(here(), props.app.baseUrl))
                  }}
                >
                  Sign in with {s().name}
                </Button>
              </>
            )}
          </Show>

          <Show when={options().local}>
            <form class="crow-signin__local nc-stack" data-part="signin-local" onSubmit={submitLocalLink}>
              <span class="nc-nav__label">One-time sign-in link</span>
              <p class="body nc-muted">
                Open the sign-in link from your server log, or paste the link or code below. Each link works
                once.
              </p>
              <TextField
                label="Sign-in link or code"
                id="local-signin-link"
                placeholder="/auth/link/..."
                value={linkInput()}
                error={linkError()}
                onInput={(e) => {
                  setLinkInput(e.currentTarget.value)
                  if (linkError()) setLinkError(undefined)
                }}
              />
              <Button variant={sso() ? "secondary" : "primary"} type="submit" data-part="signin-local-submit">
                Continue with link
              </Button>
            </form>
          </Show>

          <Show when={options().devLogin}>
            <form
              class="crow-signin__dev nc-stack"
              data-part="signin-dev"
              onSubmit={(e) => {
                e.preventDefault()
                props.app.goExternal(devLoginUrl(devUser().trim() || "dev", here(), props.app.baseUrl))
              }}
            >
              <span class="nc-nav__label">Development sign-in</span>
              <p class="body nc-muted">
                This is a development server. Pick a name to sign in as name@dev.local.
              </p>
              <div class="crow-signin__chips">
                <For each={DEV_USERS}>
                  {(u) => (
                    <Button
                      size="sm"
                      variant="ghost"
                      type="button"
                      onClick={() => setDevUser(u)}
                      data-dev-user={u}
                    >
                      {u}
                    </Button>
                  )}
                </For>
              </div>
              <TextField
                label="Name"
                id="dev-user"
                value={devUser()}
                onInput={(e) => setDevUser(e.currentTarget.value)}
                help={'"admin" signs in as an admin.'}
              />
              <Button variant={sso() || options().local ? "secondary" : "primary"} type="submit">
                Sign in as {devUser() || "dev"}
              </Button>
            </form>
          </Show>

          <Show when={!sso() && !options().devLogin && !options().local}>
            <Callout tone="warning" data-part="signin-unconfigured">
              This server has no sign-in method configured yet. Configure OIDC or local accounts on Rookery
              and restart <span class="nc-mono">rookery serve</span>.
            </Callout>
          </Show>
        </div>
      </Frame>
    </main>
  )
}
