import { useState } from "react";

export function CliLoginPage({ userCode }: Readonly<{ userCode: string }>) {
  const [status, setStatus] = useState<
    "idle" | "approved" | "needs-sign-in" | "error"
  >("idle");
  const returnTo = `/cli-login/${encodeURIComponent(userCode)}`;
  const googleLoginUrl = `/auth/google?returnTo=${encodeURIComponent(returnTo)}`;

  async function approveLogin() {
    const response = await fetch("/api/cli-login/confirm", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ userCode })
    });

    if (!response.ok) {
      if (response.status === 401) {
        setStatus("needs-sign-in");
        return;
      }

      setStatus("error");
      return;
    }

    setStatus("approved");
  }

  return (
    <main className="app-shell">
      <section className="status-header" aria-labelledby="page-title">
        <div>
          <p className="product-name">Pagelet</p>
          <h1 id="page-title">CLI Login</h1>
        </div>
        <div className="status-pill">{userCode}</div>
      </section>
      <section className="phase-panel" aria-labelledby="login-title">
        <div className="section-heading">
          <h2 id="login-title">Approve this CLI session</h2>
          <p>Only approve this request if you started `pagelet login`.</p>
        </div>
        {status === "needs-sign-in" ? (
          <a className="comment-mode-button" href={googleLoginUrl}>
            Sign in with Google
          </a>
        ) : null}
        <button
          className="comment-mode-button"
          type="button"
          onClick={() => {
            approveLogin().catch(() => setStatus("error"));
          }}
        >
          Approve
        </button>
        {status === "approved" ? <p>Login approved. You can return to the CLI.</p> : null}
        {status === "needs-sign-in" ? (
          <p>Sign in with your allowed Google account, then approve again.</p>
        ) : null}
        {status === "error" ? <p>Could not approve this login.</p> : null}
      </section>
    </main>
  );
}
