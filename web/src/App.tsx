import { CliLoginPage } from "./pages/cli-login";
import { HomePage } from "./pages/home";
import { PageletViewer } from "./pages/viewer";

const viewerPath = /^\/p\/([^/]+)\/?$/;
const cliLoginPath = /^\/cli-login\/([^/]+)\/?$/;

/**
 * There are three pages and no client-side navigation between them: every link
 * is a real link, so reading the current path once is the whole router.
 */
export function App() {
  const { pathname } = window.location;

  if (pathname === "/") {
    return <HomePage />;
  }

  const viewerMatch = viewerPath.exec(pathname);

  if (viewerMatch?.[1]) {
    return <PageletViewer shareId={decodeURIComponent(viewerMatch[1])} />;
  }

  const cliLoginMatch = cliLoginPath.exec(pathname);

  if (cliLoginMatch?.[1]) {
    return <CliLoginPage userCode={decodeURIComponent(cliLoginMatch[1])} />;
  }

  return <NotFoundPage />;
}

function NotFoundPage() {
  return (
    <main className="app-shell">
      <section className="status-header" aria-labelledby="page-title">
        <div>
          <p className="product-name">Pagelet</p>
          <h1 id="page-title">Not Found</h1>
        </div>
      </section>
      <section className="phase-panel">
        <p>There is nothing at this address.</p>
      </section>
    </main>
  );
}
