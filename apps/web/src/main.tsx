import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@medveris/ui/styles.css";
import "./styles.css";
import { AuthProvider } from "./lib/auth";
import { App } from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("Application root missing");
createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
