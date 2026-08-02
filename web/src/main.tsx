import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/app.css";

const container = document.getElementById("root");

if (!container) {
  throw new Error("Pagelet could not find the app root element");
}

createRoot(container).render(<App />);
