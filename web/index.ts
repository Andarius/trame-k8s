import type { FrontendPlugin } from "@trame/web-api";
import { K8sPanel } from "./Panel.tsx";
import { K8sSettings } from "./Settings.tsx";

export default {
  id: "k8s",
  Panel: K8sPanel,
  Settings: K8sSettings,
} satisfies FrontendPlugin;
