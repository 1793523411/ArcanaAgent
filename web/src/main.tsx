import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ToastProvider } from "./components/Toast";
import App from "./App";
import SharedView from "./components/SharedView";
import "./index.css";
import "highlight.js/styles/github-dark.css";

const THEME_KEY = "arcana-agent-theme";
const saved = localStorage.getItem(THEME_KEY);
if (saved === "light") {
  document.documentElement.classList.add("theme-light");
} else {
  document.documentElement.classList.remove("theme-light");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <Routes>
          <Route path="/share/:shareId" element={<SharedView />} />
          <Route path="/*" element={<App />} />
        </Routes>
      </ToastProvider>
    </BrowserRouter>
  </React.StrictMode>
);
