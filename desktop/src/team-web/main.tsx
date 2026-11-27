import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TeamReviewApp } from "./TeamReviewApp";
import "./team-review.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TeamReviewApp />
  </StrictMode>,
);
