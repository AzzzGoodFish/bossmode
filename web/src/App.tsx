import { useState, useEffect } from "react";
import { getToken, clearToken, setOnUnauthorized } from "./api/client";
import { Login } from "./pages/Login";
import { Layout } from "./pages/Layout";
import { DialogProvider } from "./components/dialogs";

export function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(!!getToken());

  useEffect(() => {
    setOnUnauthorized(() => setIsAuthenticated(false));
  }, []);
  const [username, setUsername] = useState(localStorage.getItem("bossmode_username") || "user");

  const handleLogin = (name: string) => {
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
        <Login onLogin={handleLogin} />
      </DialogProvider>
    );
  }

  return (
    <DialogProvider>
      <Layout onLogout={handleLogout} username={username} />
    </DialogProvider>
  );
}
