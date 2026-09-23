import { useState, useEffect } from "react";
import { getToken, clearToken, setOnUnauthorized } from "./api/client";
import { Login } from "./pages/Login";
import { GrokApp } from "./grok/GrokApp";
import { clearDrafts, pauseUploads } from "./grok/drafts";
import { DialogProvider } from "./components/dialogs";

export function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(!!getToken());

  const [expired, setExpired] = useState(false);
  useEffect(() => {
    setOnUnauthorized(() => { pauseUploads(); setExpired(true); setIsAuthenticated(false); });
  }, []);
  const [username, setUsername] = useState(localStorage.getItem("bossmode_username") || "user");

  const handleLogin = (name: string) => {
    if (name !== username) clearDrafts();
    setExpired(false);
    setUsername(name);
    localStorage.setItem("bossmode_username", name);
    setIsAuthenticated(true);
  };

  const handleLogout = () => {
    clearToken();
    localStorage.removeItem("bossmode_username");
    setIsAuthenticated(false);
  };

  if (!isAuthenticated) {
    return (
      <DialogProvider>
        <Login onLogin={handleLogin} expired={expired} />
      </DialogProvider>
    );
  }

  return (
    <DialogProvider>
      <GrokApp onLogout={handleLogout} username={username} />
    </DialogProvider>
  );
}
