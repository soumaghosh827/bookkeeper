import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/index.css";
import { applyThemeHint } from "./lib/theme";
applyThemeHint(); // login screen opens in the last-used theme
createRoot(document.getElementById("root")!).render(<App />);
