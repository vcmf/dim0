import { afterEach, describe, expect, it } from "vitest"
import {
  buildGoogleAuthUrl,
  consumePendingGoogleOAuth,
  initiateWebGoogleSignin,
  webGoogleRedirectUri,
} from "./web-google"


afterEach(() => sessionStorage.clear())


describe("consumePendingGoogleOAuth", () => {
  it("returns null when nothing is stashed", () => {
    expect(consumePendingGoogleOAuth()).toBeNull()
  })

  it("reads a valid entry once, then clears it", () => {
    sessionStorage.setItem("google_web_oauth", JSON.stringify({ verifier: "v1", state: "s1" }))
    expect(consumePendingGoogleOAuth()).toEqual({ verifier: "v1", state: "s1" })
    expect(consumePendingGoogleOAuth()).toBeNull() // single-use
  })

  it("returns null for malformed / partial entries", () => {
    sessionStorage.setItem("google_web_oauth", "{ not json")
    expect(consumePendingGoogleOAuth()).toBeNull()
    sessionStorage.setItem("google_web_oauth", JSON.stringify({ verifier: "v" })) // no state
    expect(consumePendingGoogleOAuth()).toBeNull()
  })
})


describe("buildGoogleAuthUrl", () => {
  it("targets Google's consent endpoint with the auth-code + PKCE params", () => {
    const url = new URL(buildGoogleAuthUrl("web-client-123", "challenge-abc", "state-xyz"))
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth")
    expect(url.searchParams.get("client_id")).toBe("web-client-123")
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("code_challenge")).toBe("challenge-abc")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("scope")).toBe("openid email profile")
    expect(url.searchParams.get("state")).toBe("state-xyz")
    expect(url.searchParams.get("redirect_uri")).toBe(webGoogleRedirectUri())
  })
})


describe("initiateWebGoogleSignin", () => {
  it("stashes a PKCE verifier + state (later validated on the callback)", async () => {
    // window.location.assign is a no-op in the test env — we assert the stash.
    await initiateWebGoogleSignin("web-client-123")
    const stashed = JSON.parse(sessionStorage.getItem("google_web_oauth") ?? "{}")
    expect(typeof stashed.verifier).toBe("string")
    expect(stashed.verifier.length).toBeGreaterThan(0)
    expect(typeof stashed.state).toBe("string")
    expect(stashed.state.length).toBeGreaterThan(0)
  })
})
