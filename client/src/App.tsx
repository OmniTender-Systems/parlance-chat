import { useEffect } from 'react';
import { AuthProvider, useAuth } from './AuthContext';
import { LoginPage } from './LoginPage';
import { ChatPage } from './ChatPage';
import { connectSocket } from './socket';

function Shell() {
  const { auth } = useAuth();

  // reconnect the socket on page reload if we already have a stored session
  useEffect(() => {
    if (auth) connectSocket(auth.token);
  }, [auth]);

  return auth ? <ChatPage /> : <LoginPage />;
}

function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}

export default App;
