"use client";

import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
import AutoAwesomeOutlinedIcon from "@mui/icons-material/AutoAwesomeOutlined";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import ExtensionOutlinedIcon from "@mui/icons-material/ExtensionOutlined";
import GroupsOutlinedIcon from "@mui/icons-material/GroupsOutlined";
import HubOutlinedIcon from "@mui/icons-material/HubOutlined";
import MenuRoundedIcon from "@mui/icons-material/MenuRounded";
import MemoryOutlinedIcon from "@mui/icons-material/MemoryOutlined";
import MenuBookOutlinedIcon from "@mui/icons-material/MenuBookOutlined";
import PublicOutlinedIcon from "@mui/icons-material/PublicOutlined";
import ScienceOutlinedIcon from "@mui/icons-material/ScienceOutlined";
import SecurityOutlinedIcon from "@mui/icons-material/SecurityOutlined";
import VpnKeyOutlinedIcon from "@mui/icons-material/VpnKeyOutlined";
import {
  AppBar,
  Box,
  Collapse,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Toolbar,
  Typography,
} from "@mui/material";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useState } from "react";
import { localized, SettingsDialog, useConsoleContexts } from "./settings-dialog";

const navigationWidth = 272;
type NavigationItem = { href: string; label: string; icon: ReactNode; selected: (pathname: string) => boolean };
type NavigationGroup = {
  items: NavigationItem[];
  label: string;
  icon: ReactNode;
  selected: (pathname: string) => boolean;
};
type NavigationEntry = NavigationItem | NavigationGroup;

function isNavigationGroup(item: NavigationEntry): item is NavigationGroup {
  return "items" in item;
}

export function ConsoleShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const locale = useLocale();
  const t = useTranslations("Navigation");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(pathname.startsWith("/agent-factory") || pathname.startsWith("/assets/individual"));
  const [worldOpen, setWorldOpen] = useState(pathname.startsWith("/world-factory") || pathname.startsWith("/assets/global"));
  const { contexts, visibleContexts, refresh } = useConsoleContexts();
  if (pathname === "/login") return <>{children}</>;

  const experiment: NavigationItem = {
    href: "/",
    label: t("experimentWorkbench"),
    icon: <ScienceOutlinedIcon />,
    selected: (path) => path === "/" || path.startsWith("/runs/"),
  };
  const agentItems: NavigationItem[] = [
    { href: "/agent-factory/execution-providers", label: "Execution Providers", icon: <VpnKeyOutlinedIcon />, selected: (path) => path.startsWith("/agent-factory/execution-providers") },
    { href: "/agent-factory/personas", label: t("personas"), icon: <DescriptionOutlinedIcon />, selected: (path) => path.startsWith("/agent-factory/personas") },
    { href: "/agent-factory/skills", label: t("skills"), icon: <ExtensionOutlinedIcon />, selected: (path) => path.startsWith("/agent-factory/skills") },
    { href: "/agent-factory/environments", label: t("environments"), icon: <SecurityOutlinedIcon />, selected: (path) => path.startsWith("/agent-factory/environments") },
  ];
  const worldEnvironmentItems: NavigationItem[] = visibleContexts.flatMap((context) =>
    context.available
      ? context.worldEnvironment.collections.map((collection) => {
        const href = `/world-factory/environments/${encodeURIComponent(context.contextId)}/${encodeURIComponent(collection.id)}`;
        return {
          href,
          label: localized(collection.label, locale),
          icon: <Box aria-hidden sx={{ bgcolor: "text.disabled", borderRadius: "50%", height: 5, width: 5 }} />,
          selected: (path: string) => path.startsWith(href),
        };
      })
      : []
  );
  const worldItems: NavigationEntry[] = [
    { href: "/world-factory/populations", label: t("populations"), icon: <GroupsOutlinedIcon />, selected: (path) => path.startsWith("/world-factory/populations") },
    { href: "/world-factory/rounds", label: t("rounds"), icon: <AutoAwesomeOutlinedIcon />, selected: (path) => path.startsWith("/world-factory/rounds") },
    {
      items: worldEnvironmentItems,
      label: t("environments"),
      icon: <PublicOutlinedIcon />,
      selected: (path) => path.startsWith("/world-factory/environments"),
    },
  ];
  const llm: NavigationItem = {
    href: "/llm-config",
    label: t("llmConfiguration"),
    icon: <MemoryOutlinedIcon />,
    selected: (path) => path.startsWith("/llm-config") || path.startsWith("/runtime"),
  };
  const dataDictionary: NavigationItem = {
    href: "/data-dictionary",
    label: t("dataDictionary"),
    icon: <MenuBookOutlinedIcon />,
    selected: (path) => path.startsWith("/data-dictionary"),
  };
  const contextInstallations: NavigationItem = {
    href: "/contexts/installations",
    label: "Context Plugins",
    icon: <ExtensionOutlinedIcon />,
    selected: (path) => path.startsWith("/contexts/installations"),
  };

  const closeMobile = () => setMobileOpen(false);
  const navigation = <Box component="nav" aria-label="Console navigation" sx={{ display: "flex", flexDirection: "column", height: "100%", p: 2 }}>
    <Box sx={{ alignItems: "center", display: "flex", gap: 1.25, minHeight: 44, px: 1 }}>
      <Box aria-hidden sx={{ bgcolor: "primary.main", borderRadius: 1.25, height: 24, width: 24 }} />
      <Typography sx={{ fontWeight: 750, letterSpacing: "-.03em" }}>OpenLeek</Typography>
    </Box>
    <List disablePadding sx={{ mt: 3 }}>
      <NavigationLink item={experiment} pathname={pathname} onNavigate={closeMobile} />
      <FeatureGroup
        icon={<AccountTreeOutlinedIcon />}
        items={agentItems}
        label={t("agentFactory")}
        onNavigate={closeMobile}
        onToggle={() => setAgentOpen((value) => !value)}
        open={agentOpen}
        parentHref="/agent-factory"
        pathname={pathname}
      />
      <FeatureGroup
        icon={<HubOutlinedIcon />}
        items={worldItems}
        label={t("worldFactory")}
        onNavigate={closeMobile}
        onToggle={() => setWorldOpen((value) => !value)}
        open={worldOpen}
        parentHref="/world-factory/populations"
        pathname={pathname}
      />
      <NavigationLink item={dataDictionary} pathname={pathname} onNavigate={closeMobile} />
      <NavigationLink item={contextInstallations} pathname={pathname} onNavigate={closeMobile} />
      <NavigationLink item={llm} pathname={pathname} onNavigate={closeMobile} />
    </List>
    <Box sx={{ mt: "auto", pt: 2 }}>
      <Divider sx={{ mb: 1.25 }} />
      <Box sx={{ alignItems: "center", display: "flex", justifyContent: "space-between", px: .5 }}>
        <Typography color="text.secondary" variant="caption">{t("settings")}</Typography>
        <SettingsDialog contexts={contexts} onContextsChanged={refresh} />
      </Box>
      {visibleContexts.length ? <Typography color="text.disabled" sx={{ display: "block", px: .5 }} variant="caption">
        {t("visibleContexts", { count: visibleContexts.length })}
      </Typography> : null}
    </Box>
  </Box>;

  return <Box sx={{ minHeight: "100dvh", bgcolor: "background.default", display: "flex" }}>
    <Drawer variant="permanent" sx={{ display: { xs: "none", lg: "block" }, "& .MuiDrawer-paper": { borderRightColor: "divider", boxSizing: "border-box", width: navigationWidth } }}>{navigation}</Drawer>
    <AppBar color="inherit" elevation={0} position="fixed" sx={{ bgcolor: "rgba(245,247,246,.92)", borderBottom: 1, borderColor: "divider", display: { lg: "none" }, left: 0, right: 0, width: "auto", backdropFilter: "blur(12px)" }}>
      <Toolbar sx={{ minHeight: "60px !important" }}>
        <IconButton aria-label={t("open")} edge="start" onClick={() => setMobileOpen(true)}><MenuRoundedIcon /></IconButton>
        <Typography sx={{ fontWeight: 750, ml: 1 }}>OpenLeek</Typography>
      </Toolbar>
    </AppBar>
    <Drawer anchor="left" onClose={() => setMobileOpen(false)} open={mobileOpen} sx={{ display: { lg: "none" }, "& .MuiDrawer-paper": { width: navigationWidth } }}>{navigation}</Drawer>
    <Box id="console-main" sx={{ flex: 1, minWidth: 0, ml: { lg: `${navigationWidth}px` }, pt: { xs: 7.5, lg: 0 } }}>{children}</Box>
  </Box>;
}

function FeatureGroup({ icon, items, label, onNavigate, onToggle, open, parentHref, pathname }: {
  icon: ReactNode; items: NavigationEntry[]; label: string; onNavigate(): void; onToggle(): void; open: boolean; parentHref: string; pathname: string;
}) {
  const selected = items.some((item) => item.selected(pathname)) || pathname === parentHref;
  return <>
    <ListItemButton selected={selected} sx={{ borderRadius: 1.5, mt: .5, pr: .5 }}>
      <ListItemIcon sx={{ minWidth: 36 }}>{icon}</ListItemIcon>
      <ListItemText
        primary={<Box component={Link} href={parentHref} onClick={onNavigate} sx={{ color: "text.primary", display: "block", fontSize: ".9rem", fontWeight: selected ? 700 : 550, textDecoration: "none" }}>{label}</Box>}
      />
      <IconButton aria-label={label} onClick={onToggle} size="small">{open ? "−" : "+"}</IconButton>
    </ListItemButton>
    <Collapse in={open} timeout="auto" unmountOnExit>
      <List disablePadding sx={{ ml: 1.5, mt: .5 }}>
        {items.map((item) => isNavigationGroup(item)
          ? <NestedNavigationGroup item={item} key={item.label} pathname={pathname} onNavigate={onNavigate} />
          : <NavigationLink compact item={item} key={item.href} pathname={pathname} onNavigate={onNavigate} />)}
      </List>
    </Collapse>
  </>;
}

function NestedNavigationGroup({ item, onNavigate, pathname }: {
  item: NavigationGroup; onNavigate(): void; pathname: string;
}) {
  const [open, setOpen] = useState(item.selected(pathname));
  const selected = item.selected(pathname);
  return <>
    <ListItemButton
      onClick={() => setOpen((value) => !value)}
      selected={selected}
      sx={{ borderRadius: 1.5, mb: .5, minHeight: 38, pl: 1.5, pr: .5 }}
    >
      <ListItemIcon sx={{ color: selected ? "primary.main" : "text.secondary", minWidth: 32 }}>{item.icon}</ListItemIcon>
      <ListItemText primary={item.label} slotProps={{ primary: { sx: { fontSize: ".82rem", fontWeight: selected ? 700 : 550 } } }} />
      <Typography aria-hidden color="text.secondary" variant="caption">{open ? "−" : "+"}</Typography>
    </ListItemButton>
    <Collapse in={open} timeout="auto" unmountOnExit>
      <List disablePadding sx={{ ml: 2 }}>
        {item.items.map((child) =>
          <NavigationLink compact item={child} key={child.href} pathname={pathname} onNavigate={onNavigate} />
        )}
      </List>
    </Collapse>
  </>;
}

function NavigationLink({ compact = false, item, onNavigate, pathname }: { compact?: boolean; item: NavigationItem; onNavigate(): void; pathname: string }) {
  return <ListItemButton component={Link} href={item.href} onClick={onNavigate} selected={item.selected(pathname)} sx={{ borderRadius: 1.5, mb: .5, minHeight: compact ? 38 : 44, pl: compact ? 1.5 : 1.25 }}>
    <ListItemIcon sx={{ color: item.selected(pathname) ? "primary.main" : "text.secondary", minWidth: compact ? 32 : 36 }}>{item.icon}</ListItemIcon>
    <ListItemText primary={item.label} slotProps={{ primary: { sx: { fontSize: compact ? ".82rem" : ".9rem", fontWeight: item.selected(pathname) ? 700 : 550 } } }} />
  </ListItemButton>;
}
