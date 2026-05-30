import { createContext, useContext, type ReactNode } from "react";

export interface BotIdentity {
  botName: string;
  botIcon: string;
  botAvatarUrl: string | null;
}

const BotIdentityContext = createContext<BotIdentity>({
  botName: "nanobot",
  botIcon: "",
  botAvatarUrl: null,
});

export function BotIdentityProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: BotIdentity;
}) {
  return (
    <BotIdentityContext.Provider value={value}>
      {children}
    </BotIdentityContext.Provider>
  );
}

export function useBotIdentity(): BotIdentity {
  return useContext(BotIdentityContext);
}
