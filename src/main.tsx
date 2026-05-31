import ReactDOM from "react-dom/client";
import App from "./App";

// No StrictMode: this app's effects fire native CR3 reads over IPC and create
// (and revoke) blob URLs. StrictMode's dev-only double-invoke would double those
// side effects, muddying latency logs. Keep dev behavior == prod behavior.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
