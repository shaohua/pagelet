import { useState } from "react";

export function CliLoginPage({ userCode }: Readonly<{ userCode: string }>) {
  const [status, setStatus] = useState<"idle" | "approved" | "error">("idle");

  async function approveLogin() {
    const response = await fetch("/api/cli-login/confirm", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ userCode })
    });

    if (!response.ok) {
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
        {status === "error" ? <p>Could not approve this login.</p> : null}
      </section>
    </main>
  );
}
