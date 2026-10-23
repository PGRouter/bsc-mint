import { Suspense } from "react";
import DeploymentPanel from "./panel";

export default function Page() {
  return <Suspense><DeploymentPanel /></Suspense>;
}
