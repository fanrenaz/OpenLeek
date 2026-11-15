"use client";

import ArrowBackRounded from "@mui/icons-material/ArrowBackRounded";
import ChatBubbleOutlineRounded from "@mui/icons-material/ChatBubbleOutlineRounded";
import Groups2Outlined from "@mui/icons-material/Groups2Outlined";
import HomeRounded from "@mui/icons-material/HomeRounded";
import PersonOutlineRounded from "@mui/icons-material/PersonOutlineRounded";
import RefreshRounded from "@mui/icons-material/RefreshRounded";
import RepeatRounded from "@mui/icons-material/RepeatRounded";
import SearchRounded from "@mui/icons-material/SearchRounded";
import ThumbUpAltOutlined from "@mui/icons-material/ThumbUpAltOutlined";
import {
  Alert, Avatar, Box, Button, Chip, CircularProgress, Divider, Drawer, FormControl,
  IconButton, InputAdornment, InputLabel, List, ListItemButton, ListItemIcon,
  ListItemText, MenuItem, Paper, Select, Skeleton, Stack, TextField, Toolbar,
  Tooltip, Typography, useMediaQuery, useTheme,
} from "@mui/material";
import { useCallback, useEffect, useRef, useState } from "react";
import { observerPollIntervalMs } from "../../../observer-poll";

type Manifest = { ref: string; roundId: number; financialRevisionRef: string; socialRevisionRef: string };
type Head = {
  runId: string; lifecycle: string; committedRound: number; configuredRounds: number;
  failure?: { category: string; message: string }; manifest: Manifest | null;
};
type Actor = { actorId: string; displayName: string };
type Post = {
  postId: string; authorId: string; author: Actor; content: string; headline: string; roundId: number;
  postType?: "original" | "repost" | "reply"; parentPostId?: string;
  likeCount: number; repostCount: number; replyCount: number;
};
type Timeline = {
  revision: { ref: string; roundId: number };
  delta: { newPostIds: string[]; changedPostIds: string[] };
  items: Post[];
  nextCursor?: string;
};
type Profile = { actor: Actor; followerCount: number; followingCount: number; posts: Post[] };
type PostDetail = { post: Post; replies: Post[]; engagements: Array<{ engagementId: string; kind: string; actor?: Actor; replyBody?: string }> };

const TERMINAL = new Set(["completed", "cancelled", "failed"]);

export function SocialObserverClient({ runId }: { runId: string }) {
  const theme = useTheme();
  const compact = useMediaQuery(theme.breakpoints.down("md"));
  const [head, setHead] = useState<Head>();
  const [rounds, setRounds] = useState<Manifest[]>([]);
  const [selected, setSelected] = useState<Manifest>();
  const [following, setFollowing] = useState(true);
  const [timeline, setTimeline] = useState<Timeline>();
  const [selectedPost, setSelectedPost] = useState<PostDetail>();
  const [profile, setProfile] = useState<Profile>();
  const [query, setQuery] = useState("");
  const [drawer, setDrawer] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const selectedRef = useRef<string | undefined>(undefined);

  const loadRounds = useCallback(async () => {
    const value = await requestJson<{ items: Array<{ roundId: number; manifestRef: string; financialRevisionRef: string; socialRevisionRef: string }> }>(
      `/api/observer/runs/${encodeURIComponent(runId)}/rounds?limit=200`,
    );
    const items = value.items.map(({ manifestRef, ...item }) => ({ ...item, ref: manifestRef }));
    setRounds(items);
    return items;
  }, [runId]);

  const loadTimeline = useCallback(async (manifest: Manifest, search = "") => {
    if (selectedRef.current === manifest.socialRevisionRef && !search) return;
    setLoading(true);
    const q = search ? `&q=${encodeURIComponent(search)}` : "";
    try {
      const next = await requestJson<Timeline>(
        `/contexts/social/observer-api?runId=${encodeURIComponent(runId)}&revisionRef=${encodeURIComponent(manifest.socialRevisionRef)}&view=timeline&limit=100${q}`,
      );
      if (!search) selectedRef.current = manifest.socialRevisionRef;
      setTimeline(next);
      setSelected(manifest);
      setSelectedPost(undefined);
      setError("");
      if (!search && next.items[0]) void loadProfile(next.items[0].authorId, manifest.socialRevisionRef);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setLoading(false);
    }
  }, [runId]);

  const loadHead = useCallback(async () => {
    try {
      const next = await requestJson<Head>(`/api/observer/runs/${encodeURIComponent(runId)}/head`);
      setHead(next);
      if (next.manifest && following && selectedRef.current !== next.manifest.socialRevisionRef) {
        const items = await loadRounds();
        const manifest = items.find((item) => item.socialRevisionRef === next.manifest?.socialRevisionRef) ?? next.manifest;
        await loadTimeline(manifest);
      } else if (!next.manifest) {
        setLoading(false);
      }
    } catch (reason) {
      setError(message(reason));
      setLoading(false);
    }
  }, [following, loadRounds, loadTimeline, runId]);

  const loadProfile = async (actorId: string, revisionRef = selected?.socialRevisionRef) => {
    if (!revisionRef) return;
    try {
      setProfile(await requestJson<Profile>(
        `/contexts/social/observer-api?runId=${encodeURIComponent(runId)}&revisionRef=${encodeURIComponent(revisionRef)}&view=profile&actorId=${encodeURIComponent(actorId)}`,
      ));
    } catch (reason) { setError(message(reason)); }
  };
  const openPost = async (post: Post) => {
    if (!selected) return;
    try {
      setSelectedPost(await requestJson<PostDetail>(
        `/contexts/social/observer-api?runId=${encodeURIComponent(runId)}&revisionRef=${encodeURIComponent(selected.socialRevisionRef)}&view=post&postId=${encodeURIComponent(post.postId)}`,
      ));
      void loadProfile(post.authorId);
    } catch (reason) { setError(message(reason)); }
  };

  useEffect(() => { void loadRounds().then(() => loadHead()); }, [loadHead, loadRounds]);
  useEffect(() => {
    if (!following || (head && TERMINAL.has(head.lifecycle))) return;
    const timer = setInterval(() => void loadHead(), observerPollIntervalMs);
    return () => clearInterval(timer);
  }, [following, head, loadHead]);

  const chooseRound = (revisionRef: string) => {
    const manifest = rounds.find((item) => item.socialRevisionRef === revisionRef);
    if (!manifest) return;
    setFollowing(false);
    void loadTimeline(manifest);
  };
  const followLatest = () => {
    selectedRef.current = undefined;
    setFollowing(true);
    void loadHead();
  };
  const search = () => { if (selected) void loadTimeline(selected, query.trim()); };

  const navigation = <Navigation runId={runId} following={following} selected={selected} onLatest={followLatest} onClose={() => setDrawer(false)} />;
  return <Box sx={{ minHeight: "100vh", bgcolor: "background.default" }}>
    {compact && <Toolbar sx={{ position: "sticky", top: 0, zIndex: 10, bgcolor: "rgba(0,0,0,.9)", borderBottom: 1, borderColor: "divider" }}>
      <IconButton onClick={() => setDrawer(true)}><Groups2Outlined /></IconButton><Typography sx={{ flex: 1, fontWeight: 800 }}>OpenLeek Social</Typography><Chip label={`R${selected?.roundId ?? "—"}`} size="small" />
    </Toolbar>}
    <Drawer open={compact && drawer} onClose={() => setDrawer(false)}>{navigation}</Drawer>
    <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "240px minmax(0, 620px) minmax(280px, 360px)" }, maxWidth: 1240, minHeight: "100vh", mx: "auto" }}>
      {!compact && <Box component="nav" sx={{ borderRight: 1, borderColor: "divider", position: "sticky", top: 0, height: "100vh" }}>{navigation}</Box>}
      <Box component="main" sx={{ minWidth: 0, borderRight: { md: 1 }, borderColor: "divider" }}>
        <Paper elevation={0} square sx={{ position: "sticky", top: 0, zIndex: 5, px: 2, py: 1.25, bgcolor: "rgba(0,0,0,.88)", backdropFilter: "blur(16px)", borderBottom: 1, borderColor: "divider" }}>
          <Stack direction="row" sx={{ alignItems: "center", gap: 1 }}>
            {selectedPost && <IconButton onClick={() => setSelectedPost(undefined)} size="small"><ArrowBackRounded /></IconButton>}
            <Box sx={{ flex: 1 }}><Typography sx={{ fontWeight: 800 }}>{selectedPost ? "Post" : "Public timeline"}</Typography><Typography color="text.secondary" variant="caption">{head ? `${head.lifecycle} · ${head.committedRound}/${head.configuredRounds}` : runId}</Typography></Box>
            <FormControl size="small" sx={{ minWidth: 135 }}><InputLabel>Round</InputLabel><Select label="Round" value={selected?.socialRevisionRef ?? ""} onChange={(event) => chooseRound(event.target.value)}>
              {rounds.map((item) => <MenuItem key={item.ref} value={item.socialRevisionRef}>Round {item.roundId}</MenuItem>)}
            </Select></FormControl>
          </Stack>
        </Paper>
        {error && <Alert severity="error" sx={{ m: 1.5 }}>{error}</Alert>}
        {head?.failure && <Alert severity="warning" sx={{ m: 1.5 }}>{head.failure.category}: {head.failure.message}</Alert>}
        {!head?.manifest && !error ? <Stack sx={{ alignItems: "center", py: 10, gap: 2 }}><CircularProgress size={28} /><Typography color="text.secondary">Waiting for the first committed round…</Typography></Stack>
          : loading && !timeline ? <TimelineSkeleton />
            : selectedPost ? <PostThread value={selectedPost} onProfile={(actorId) => void loadProfile(actorId)} />
              : <TimelineView timeline={timeline} onPost={(post) => void openPost(post)} onProfile={(actorId) => void loadProfile(actorId)} />}
      </Box>
      {!compact && <Box component="aside" sx={{ p: 2, position: "sticky", top: 0, height: "100vh", overflow: "auto" }}>
        <Stack sx={{ gap: 2 }}>
          <TextField onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") search(); }} placeholder="Search public posts" size="small" value={query}
            slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchRounded fontSize="small" /></InputAdornment> } }} />
          <ProfilePanel profile={profile} onPost={(post) => void openPost(post)} />
          <Paper sx={{ p: 2 }} variant="outlined"><Typography sx={{ fontWeight: 750 }}>Observer mode</Typography><Typography color="text.secondary" sx={{ mt: .5 }} variant="body2">Public committed content only. Personalized feeds, notifications and exposures are not available.</Typography></Paper>
        </Stack>
      </Box>}
    </Box>
  </Box>;
}

function Navigation({ runId, following, selected, onLatest, onClose }: { runId: string; following: boolean; selected: Manifest | undefined; onLatest(): void; onClose(): void }) {
  return <Stack sx={{ width: 240, height: "100%", p: 2 }}>
    <Typography color="primary" sx={{ px: 1, mb: 2, fontSize: "1.3rem", fontWeight: 900 }}>OpenLeek Social</Typography>
    <List>
      <ListItemButton selected onClick={onClose}><ListItemIcon><HomeRounded /></ListItemIcon><ListItemText primary="Public timeline" /></ListItemButton>
      <ListItemButton onClick={onClose}><ListItemIcon><SearchRounded /></ListItemIcon><ListItemText primary="Search" /></ListItemButton>
      <ListItemButton onClick={onClose}><ListItemIcon><PersonOutlineRounded /></ListItemIcon><ListItemText primary="Profiles" /></ListItemButton>
      <ListItemButton component="a" href={`/runs/${encodeURIComponent(runId)}`}><ListItemIcon><ArrowBackRounded /></ListItemIcon><ListItemText primary="Back to Console" /></ListItemButton>
    </List>
    <Box sx={{ flex: 1 }} />
    <Chip color={following ? "primary" : "default"} label={following ? "Following latest" : `Viewing round ${selected?.roundId ?? "—"}`} variant="outlined" />
    {!following && <Button onClick={onLatest} startIcon={<RefreshRounded />} sx={{ mt: 1 }} variant="contained">Follow latest</Button>}
  </Stack>;
}

function TimelineView({ timeline, onPost, onProfile }: { timeline: Timeline | undefined; onPost(post: Post): void; onProfile(actorId: string): void }) {
  if (!timeline?.items.length) return <Stack sx={{ alignItems: "center", py: 10 }}><Typography color="text.secondary">No public posts in this committed revision.</Typography></Stack>;
  const fresh = new Set(timeline.delta.newPostIds);
  const changed = new Set(timeline.delta.changedPostIds);
  return <Box>{timeline.items.map((post) => <PostCard key={post.postId} post={post} highlighted={fresh.has(post.postId) || changed.has(post.postId)} onClick={() => onPost(post)} onProfile={() => onProfile(post.authorId)} />)}</Box>;
}

function PostCard({ post, highlighted, onClick, onProfile }: { post: Post; highlighted?: boolean; onClick(): void; onProfile(): void }) {
  return <Box onClick={onClick} sx={{ display: "flex", gap: 1.5, px: 2, py: 1.6, cursor: "pointer", borderBottom: 1, borderColor: "divider", bgcolor: highlighted ? "rgba(29,155,240,.06)" : "transparent", transition: "background-color .2s", "&:hover": { bgcolor: "rgba(255,255,255,.025)" } }}>
    <Avatar onClick={(event) => { event.stopPropagation(); onProfile(); }} sx={{ bgcolor: avatarColor(post.authorId), fontWeight: 800 }}>{initials(post.author.displayName)}</Avatar>
    <Box sx={{ minWidth: 0, flex: 1 }}>
      <Stack direction="row" sx={{ alignItems: "baseline", gap: 1 }}><Typography sx={{ fontWeight: 750 }}>{post.author.displayName}</Typography><Typography color="text.secondary" noWrap variant="caption">@{shortId(post.authorId)} · Round {post.roundId}</Typography></Stack>
      {post.headline && <Typography sx={{ mt: .5, fontWeight: 700 }}>{post.headline}</Typography>}
      <Typography sx={{ mt: .35, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{post.content}</Typography>
      <Stack direction="row" sx={{ color: "text.secondary", justifyContent: "space-between", maxWidth: 360, mt: 1.2 }}>
        <Reaction icon={<ChatBubbleOutlineRounded fontSize="inherit" />} value={post.replyCount} />
        <Reaction icon={<RepeatRounded fontSize="inherit" />} value={post.repostCount} />
        <Reaction icon={<ThumbUpAltOutlined fontSize="inherit" />} value={post.likeCount} />
      </Stack>
    </Box>
  </Box>;
}

function Reaction({ icon, value }: { icon: React.ReactNode; value: number }) {
  return <Stack direction="row" sx={{ alignItems: "center", gap: .5, fontSize: ".9rem" }}>{icon}<Typography color="inherit" variant="caption">{value}</Typography></Stack>;
}

function PostThread({ value, onProfile }: { value: PostDetail; onProfile(actorId: string): void }) {
  return <Box><PostCard post={value.post} onClick={() => undefined} onProfile={() => onProfile(value.post.authorId)} />
    {value.replies.length ? value.replies.map((reply) => <PostCard key={reply.postId} post={reply} onClick={() => undefined} onProfile={() => onProfile(reply.authorId)} />) : <Typography color="text.secondary" sx={{ p: 3, textAlign: "center" }}>No public replies.</Typography>}
  </Box>;
}

function ProfilePanel({ profile, onPost }: { profile: Profile | undefined; onPost(post: Post): void }) {
  if (!profile) return <Paper sx={{ p: 2 }} variant="outlined"><Skeleton height={48} width={48} variant="circular" /><Skeleton sx={{ mt: 1 }} /><Skeleton width="60%" /></Paper>;
  return <Paper sx={{ overflow: "hidden" }} variant="outlined">
    <Box sx={{ height: 72, background: "linear-gradient(135deg,#0b4f78,#1d9bf0)" }} />
    <Box sx={{ px: 2, pb: 2 }}>
      <Avatar sx={{ width: 64, height: 64, mt: -4, border: 3, borderColor: "background.paper", bgcolor: avatarColor(profile.actor.actorId), fontWeight: 800 }}>{initials(profile.actor.displayName)}</Avatar>
      <Typography sx={{ mt: 1, fontWeight: 800 }}>{profile.actor.displayName}</Typography><Typography color="text.secondary" variant="body2">@{shortId(profile.actor.actorId)}</Typography>
      <Stack direction="row" sx={{ gap: 2, mt: 1.5 }}><Typography variant="body2"><b>{profile.followingCount}</b> <span style={{ color: "#71767b" }}>Following</span></Typography><Typography variant="body2"><b>{profile.followerCount}</b> <span style={{ color: "#71767b" }}>Followers</span></Typography></Stack>
      {profile.posts[0] && <Button onClick={() => onPost(profile.posts[0]!)} sx={{ mt: 1.5, px: 0 }}>Latest public post</Button>}
    </Box>
  </Paper>;
}

function TimelineSkeleton() {
  return <Stack>{Array.from({ length: 5 }, (_, index) => <Box key={index} sx={{ display: "flex", gap: 1.5, p: 2, borderBottom: 1, borderColor: "divider" }}><Skeleton height={44} width={44} variant="circular" /><Box sx={{ flex: 1 }}><Skeleton width="45%" /><Skeleton /><Skeleton width="80%" /></Box></Box>)}</Stack>;
}

async function requestJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const value = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(value.error ?? `Request failed (${response.status})`);
  return value as T;
}
function message(reason: unknown) { return reason instanceof Error ? reason.message : "Observer request failed"; }
function initials(value: string) { return value.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?"; }
function shortId(value: string) { const tail = value.split(":").at(-1) ?? value; return tail.length > 18 ? `${tail.slice(0, 15)}…` : tail; }
function avatarColor(value: string) {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 52% 38%)`;
}
