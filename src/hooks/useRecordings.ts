import { useEffect, useMemo, useState } from "react";
import { subscribeToRecordings } from "../lib/recordingRepository";
import type { Recording } from "../types";

export function useRecordings(userId: string) {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sort, setSort] = useState("newest");

  useEffect(() => {
    return subscribeToRecordings(
      userId,
      (items) => {
        setRecordings(items);
        setError("");
      },
      (entry) => setError(entry.message)
    );
  }, [userId]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matches = recordings.filter((recording) => {
      const haystack = [
        recording.title,
        recording.summary,
        recording.shortSummary,
        recording.category,
        recording.project,
        recording.status,
        ...recording.topics,
        ...recording.decisions,
        ...recording.keywords,
        ...recording.tasks.map((task) => `${task.description} ${task.owner}`),
        ...recording.transcript.map((segment) => segment.text)
      ]
        .join(" ")
        .toLowerCase();

      return (!needle || haystack.includes(needle)) && (statusFilter === "all" || recording.status === statusFilter);
    });

    return [...matches].sort((a, b) => {
      if (sort === "oldest") return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      if (sort === "longest") return b.duration - a.duration;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [recordings, search, sort, statusFilter]);

  return {
    recordings,
    filtered,
    error,
    search,
    setSearch,
    statusFilter,
    setStatusFilter,
    sort,
    setSort
  };
}
