package monitoring

import (
	"context"
	"fmt"
	"math"
	"path/filepath"
	"testing"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

func TestAnalyticsBuildsIncludedSections(t *testing.T) {
	db := newMonitoringTestStore(t)
	ctx := context.Background()
	fromMS := int64(1_778_000_000_000)
	toMS := fromMS + 2*60*60*1000
	latency := int64(250)

	if err := db.SaveModelPrices(ctx, map[string]store.ModelPrice{
		"gpt-a": {Prompt: 1, Completion: 2, Cache: 0.5},
	}); err != nil {
		t.Fatalf("save model prices: %v", err)
	}
	_, err := db.InsertEvents(ctx, []usage.Event{
		monitoringEvent("analytics-a", fromMS+1_000, "gpt-a", "auth-1", "source-a", false, 1_000_000, 500_000, 0, 100, 1_500_100, &latency),
		monitoringEvent("analytics-b", fromMS+2_000, "gpt-b", "auth-2", "source-b", true, 10, 20, 0, 0, 30, nil),
		monitoringEvent("analytics-outside", toMS, "gpt-a", "auth-1", "source-a", false, 1, 1, 0, 0, 2, nil),
	})
	if err != nil {
		t.Fatalf("insert events: %v", err)
	}

	includeFailed := true
	resp, err := New(db).Analytics(ctx, Request{
		FromMS: fromMS,
		ToMS:   toMS,
		NowMS:  toMS,
		Filters: Filters{
			IncludeFailed: &includeFailed,
		},
		Include: Include{
			Summary:            true,
			Timeline:           true,
			HourlyDistribution: true,
			ModelShare:         true,
			ChannelShare:       true,
			ModelStats:         true,
			FailureSources:     true,
			TaskBuckets:        true,
			RecentFailures:     5,
			EventsPage:         &EventsPage{Limit: 1},
			Granularity:        "hour",
		},
	})
	if err != nil {
		t.Fatalf("analytics: %v", err)
	}

	if resp.Summary == nil || resp.Summary.TotalCalls != 2 || resp.Summary.FailureCalls != 1 {
		t.Fatalf("summary = %#v", resp.Summary)
	}
	if resp.Summary.TotalCost <= 0 {
		t.Fatalf("summary cost = %v", resp.Summary.TotalCost)
	}
	if len(resp.Timeline) == 0 || len(resp.HourlyDistribution) == 0 {
		t.Fatalf("timeline = %#v hourly = %#v", resp.Timeline, resp.HourlyDistribution)
	}
	if len(resp.ModelStats) != 2 || len(resp.ModelShare) != 2 {
		t.Fatalf("model stats/share = %#v %#v", resp.ModelStats, resp.ModelShare)
	}
	if len(resp.ChannelShare) != 2 {
		t.Fatalf("channel share = %#v", resp.ChannelShare)
	}
	if len(resp.FailureSources) != 1 || resp.FailureSources[0].SourceHash == "" {
		t.Fatalf("failure sources = %#v", resp.FailureSources)
	}
	if len(resp.TaskBuckets) != 2 {
		t.Fatalf("task buckets = %#v", resp.TaskBuckets)
	}
	if len(resp.RecentFailures) != 1 || resp.RecentFailures[0].Model != "gpt-b" {
		t.Fatalf("recent failures = %#v", resp.RecentFailures)
	}
	if resp.Events == nil || len(resp.Events.Items) != 1 || !resp.Events.HasMore {
		t.Fatalf("events page = %#v", resp.Events)
	}
}

func TestAnalyticsExposesCPA7118UsageFields(t *testing.T) {
	db := newMonitoringTestStore(t)
	ctx := context.Background()
	fromMS := int64(1_778_000_000_000)
	toMS := fromMS + 60*60*1000
	latency := int64(1500)
	ttft := int64(450)
	event := monitoringEvent("cpa-7118-fields", fromMS+1_000, "client-gpt", "auth-1", "source-a", true, 10, 20, 3, 5, 33, &latency)
	event.ResolvedModel = "gpt-5.4"
	event.ExecutorType = "codex"
	event.ReasoningEffort = "medium"
	event.ServiceTier = "priority"
	event.CacheReadTokens = 4
	event.CacheCreationTokens = 1
	event.TTFTMS = &ttft
	event.FailStatusCode = 429
	event.FailBody = "rate limit exceeded"
	event.FailSummary = "rate limit exceeded"

	if _, err := db.InsertEvents(ctx, []usage.Event{event}); err != nil {
		t.Fatalf("insert events: %v", err)
	}

	resp, err := New(db).Analytics(ctx, Request{
		FromMS: fromMS,
		ToMS:   toMS,
		NowMS:  toMS,
		Include: Include{
			Summary:     true,
			ModelStats:  true,
			TaskBuckets: true,
			EventsPage:  &EventsPage{Limit: 10},
		},
	})
	if err != nil {
		t.Fatalf("analytics: %v", err)
	}
	if resp.Summary == nil || resp.Summary.CacheReadTokens != 4 ||
		resp.Summary.CacheCreationTokens != 1 || resp.Summary.CachedTokens != 0 {
		t.Fatalf("summary = %#v", resp.Summary)
	}
	if len(resp.TaskBuckets) != 1 || resp.TaskBuckets[0].CacheReadTokens != 4 ||
		resp.TaskBuckets[0].CacheCreationTokens != 1 || resp.TaskBuckets[0].CachedTokens != 0 {
		t.Fatalf("task buckets = %#v", resp.TaskBuckets)
	}
	if len(resp.ModelStats) != 1 || resp.ModelStats[0].CacheReadTokens != 4 ||
		resp.ModelStats[0].CacheCreationTokens != 1 || resp.ModelStats[0].CachedTokens != 0 {
		t.Fatalf("model stats = %#v", resp.ModelStats)
	}
	if resp.Events == nil || len(resp.Events.Items) != 1 {
		t.Fatalf("events = %#v", resp.Events)
	}
	item := resp.Events.Items[0]
	if item.ExecutorType != "codex" || item.ReasoningEffort != "medium" ||
		item.ServiceTier != "priority" || item.CacheReadTokens != 4 ||
		item.CacheCreationTokens != 1 || item.CachedTokens != 0 || item.FailStatusCode == nil ||
		*item.FailStatusCode != 429 || item.FailSummary != "rate limit exceeded" ||
		item.LatencyMS == nil || *item.LatencyMS != 1500 || item.TTFTMS == nil ||
		*item.TTFTMS != 450 {
		t.Fatalf("event item = %#v", item)
	}
}

func TestAnalyticsKeepsCompatCachedSeparateFromFineGrainedCache(t *testing.T) {
	db := newMonitoringTestStore(t)
	ctx := context.Background()
	fromMS := int64(1_778_000_000_000)
	toMS := fromMS + 60*60*1000
	event := monitoringEvent("claude-cache-mirror", fromMS+1_000, "claude-sonnet", "auth-1", "source-a", false, 100, 20, 0, 500, 120, nil)
	event.CacheReadTokens = 500

	if _, err := db.InsertEvents(ctx, []usage.Event{event}); err != nil {
		t.Fatalf("insert events: %v", err)
	}

	resp, err := New(db).Analytics(ctx, Request{
		FromMS: fromMS,
		ToMS:   toMS,
		NowMS:  toMS,
		Include: Include{
			Summary:     true,
			ModelStats:  true,
			TaskBuckets: true,
			EventsPage:  &EventsPage{Limit: 10},
		},
	})
	if err != nil {
		t.Fatalf("analytics: %v", err)
	}
	if resp.Summary == nil || resp.Summary.CachedTokens != 0 || resp.Summary.CacheReadTokens != 500 {
		t.Fatalf("summary cache fields = %#v", resp.Summary)
	}
	if len(resp.ModelStats) != 1 || resp.ModelStats[0].CachedTokens != 0 ||
		resp.ModelStats[0].CacheReadTokens != 500 {
		t.Fatalf("model stats cache fields = %#v", resp.ModelStats)
	}
	if len(resp.TaskBuckets) != 1 || resp.TaskBuckets[0].CachedTokens != 0 ||
		resp.TaskBuckets[0].CacheReadTokens != 500 {
		t.Fatalf("task buckets cache fields = %#v", resp.TaskBuckets)
	}
	if resp.Events == nil || len(resp.Events.Items) != 1 || resp.Events.Items[0].CachedTokens != 0 ||
		resp.Events.Items[0].CacheReadTokens != 500 {
		t.Fatalf("events cache fields = %#v", resp.Events)
	}
}

func TestAnalyticsDoesNotExposeOrSearchRawFailBody(t *testing.T) {
	db := newMonitoringTestStore(t)
	ctx := context.Background()
	fromMS := int64(1_778_000_000_000)
	toMS := fromMS + 60*60*1000
	event := monitoringEvent("raw-fail-body", fromMS+1_000, "client-gpt", "auth-1", "source-a", true, 1, 1, 0, 0, 2, nil)
	event.FailStatusCode = 500
	event.FailBody = "upstream stack raw-secret-marker sk-test-secret-value"
	event.FailSummary = "upstream stack [redacted]"

	if _, err := db.InsertEvents(ctx, []usage.Event{event}); err != nil {
		t.Fatalf("insert events: %v", err)
	}

	resp, err := New(db).Analytics(ctx, Request{
		FromMS:      fromMS,
		ToMS:        toMS,
		SearchQuery: "raw-secret-marker",
		Include:     Include{EventsPage: &EventsPage{Limit: 10}},
	})
	if err != nil {
		t.Fatalf("analytics raw body search: %v", err)
	}
	if resp.Events != nil && len(resp.Events.Items) != 0 {
		t.Fatalf("raw fail body should not be searchable: %#v", resp.Events)
	}

	resp, err = New(db).Analytics(ctx, Request{
		FromMS:      fromMS,
		ToMS:        toMS,
		SearchQuery: "upstream stack",
		Include:     Include{EventsPage: &EventsPage{Limit: 10}},
	})
	if err != nil {
		t.Fatalf("analytics summary search: %v", err)
	}
	if resp.Events == nil || len(resp.Events.Items) != 1 {
		t.Fatalf("summary search events = %#v", resp.Events)
	}
	item := resp.Events.Items[0]
	if item.FailSummary != "upstream stack [redacted]" {
		t.Fatalf("fail summary = %#v", item)
	}
}

func TestAnalyticsUsesResolvedModelPricingInAggregates(t *testing.T) {
	db := newMonitoringTestStore(t)
	ctx := context.Background()
	fromMS := int64(1_778_000_000_000)
	toMS := fromMS + 60*60*1000

	if err := db.SaveModelPrices(ctx, map[string]store.ModelPrice{
		"gpt-resolved-a": {Prompt: 1},
		"gpt-resolved-b": {Completion: 2},
	}); err != nil {
		t.Fatalf("save model prices: %v", err)
	}
	first := monitoringEvent("resolved-cost-a", fromMS+1_000, "alias-fast", "auth-1", "source-a", false, 1_000_000, 0, 0, 0, 1_000_000, nil)
	first.ResolvedModel = "gpt-resolved-a"
	second := monitoringEvent("resolved-cost-b", fromMS+2_000, "alias-fast", "auth-1", "source-a", false, 0, 1_000_000, 0, 0, 1_000_000, nil)
	second.ResolvedModel = "gpt-resolved-b"
	if _, err := db.InsertEvents(ctx, []usage.Event{first, second}); err != nil {
		t.Fatalf("insert events: %v", err)
	}

	resp, err := New(db).Analytics(ctx, Request{
		FromMS: fromMS,
		ToMS:   toMS,
		Include: Include{
			Summary:      true,
			ModelShare:   true,
			ModelStats:   true,
			ChannelShare: true,
		},
	})
	if err != nil {
		t.Fatalf("analytics: %v", err)
	}

	if resp.Summary == nil || math.Abs(resp.Summary.TotalCost-3) > 0.000001 {
		t.Fatalf("summary cost = %#v", resp.Summary)
	}
	if len(resp.ModelStats) != 1 || resp.ModelStats[0].Model != "alias-fast" ||
		resp.ModelStats[0].Calls != 2 || math.Abs(resp.ModelStats[0].Cost-3) > 0.000001 {
		t.Fatalf("model stats = %#v", resp.ModelStats)
	}
	if len(resp.ModelShare) != 1 || resp.ModelShare[0].Model != "alias-fast" ||
		math.Abs(resp.ModelShare[0].Cost-3) > 0.000001 {
		t.Fatalf("model share = %#v", resp.ModelShare)
	}
	if len(resp.ChannelShare) != 1 || resp.ChannelShare[0].AuthIndex != "auth-1" ||
		math.Abs(resp.ChannelShare[0].Cost-3) > 0.000001 {
		t.Fatalf("channel share = %#v", resp.ChannelShare)
	}
	if resp.ChannelShare[0].Source != "user@example.com" ||
		resp.ChannelShare[0].AccountSnapshot != "user@example.com" {
		t.Fatalf("channel share snapshots = %#v", resp.ChannelShare[0])
	}
}

func TestAnalyticsPricesPriorityAndDefaultServiceTiersSeparately(t *testing.T) {
	db := newMonitoringTestStore(t)
	ctx := context.Background()
	fromMS := int64(1_778_010_000_000)
	toMS := fromMS + 60*60*1000

	if err := db.SaveModelPrices(ctx, map[string]store.ModelPrice{
		"gpt-5.4": {Prompt: 2.5},
	}); err != nil {
		t.Fatalf("save model prices: %v", err)
	}

	latency100 := int64(100)
	latency200 := int64(200)
	latency1000 := int64(1000)
	standard := monitoringEvent("tier-default", fromMS+1_000, "gpt-5.4", "auth-1", "source-a", false, 1_000_000, 0, 0, 0, 1_000_000, &latency100)
	standard.ServiceTier = "default"
	standard.AccountSnapshot = "team@example.com"
	standard.AuthLabelSnapshot = "Team"
	standard.APIKeyHash = "client-key"
	standardSecond := monitoringEvent("tier-default-second", fromMS+1_500, "gpt-5.4", "auth-1", "source-a", false, 0, 0, 0, 0, 0, &latency200)
	standardSecond.ServiceTier = "default"
	standardSecond.AccountSnapshot = "team@example.com"
	standardSecond.AuthLabelSnapshot = "Team"
	standardSecond.APIKeyHash = "client-key"
	priority := monitoringEvent("tier-priority", fromMS+2_000, "gpt-5.4", "auth-1", "source-a", false, 1_000_000, 0, 0, 0, 1_000_000, &latency1000)
	priority.ServiceTier = "priority"
	priority.AccountSnapshot = "team@example.com"
	priority.AuthLabelSnapshot = "Team"
	priority.APIKeyHash = "client-key"
	if _, err := db.InsertEvents(ctx, []usage.Event{standard, standardSecond, priority}); err != nil {
		t.Fatalf("insert events: %v", err)
	}

	resp, err := New(db).Analytics(ctx, Request{
		FromMS: fromMS,
		ToMS:   toMS,
		Include: Include{
			Summary:      true,
			ModelShare:   true,
			ModelStats:   true,
			ChannelShare: true,
			AccountStats: true,
			APIKeyStats:  true,
		},
	})
	if err != nil {
		t.Fatalf("analytics: %v", err)
	}

	assertCost := func(name string, got float64) {
		t.Helper()
		if math.Abs(got-7.5) > 0.000001 {
			t.Fatalf("%s cost = %v, want 7.5", name, got)
		}
	}
	if resp.Summary == nil {
		t.Fatal("summary is nil")
	}
	assertCost("summary", resp.Summary.TotalCost)
	if len(resp.ModelStats) != 1 || resp.ModelStats[0].Calls != 3 {
		t.Fatalf("model stats = %#v", resp.ModelStats)
	}
	assertCost("model stats", resp.ModelStats[0].Cost)
	if len(resp.ModelShare) != 1 {
		t.Fatalf("model share = %#v", resp.ModelShare)
	}
	assertCost("model share", resp.ModelShare[0].Cost)
	if len(resp.ChannelShare) != 1 {
		t.Fatalf("channel share = %#v", resp.ChannelShare)
	}
	assertCost("channel share", resp.ChannelShare[0].Cost)
	if resp.ChannelShare[0].AvgLatencyMS == nil || math.Abs(*resp.ChannelShare[0].AvgLatencyMS-(1300.0/3.0)) > 0.000001 {
		t.Fatalf("channel latency = %#v, want weighted 433.333333", resp.ChannelShare[0].AvgLatencyMS)
	}
	if len(resp.AccountStats) != 1 || len(resp.AccountStats[0].Models) != 1 {
		t.Fatalf("account stats = %#v", resp.AccountStats)
	}
	assertCost("account stats", resp.AccountStats[0].Cost)
	assertCost("account model stats", resp.AccountStats[0].Models[0].Cost)
	if len(resp.APIKeyStats) != 1 || len(resp.APIKeyStats[0].Models) != 1 {
		t.Fatalf("api key stats = %#v", resp.APIKeyStats)
	}
	assertCost("api key stats", resp.APIKeyStats[0].Cost)
	assertCost("api key model stats", resp.APIKeyStats[0].Models[0].Cost)
}

func TestAnalyticsAppliesFilters(t *testing.T) {
	db := newMonitoringTestStore(t)
	ctx := context.Background()
	fromMS := int64(1_778_000_000_000)
	toMS := fromMS + 60*60*1000
	includeFailed := false

	_, err := db.InsertEvents(ctx, []usage.Event{
		monitoringEvent("filter-a", fromMS+1_000, "gpt-a", "auth-1", "source-a", false, 1, 1, 0, 0, 2, nil),
		monitoringEvent("filter-b", fromMS+2_000, "gpt-a", "auth-1", "source-a", true, 1, 1, 0, 0, 2, nil),
		monitoringEvent("filter-c", fromMS+3_000, "gpt-b", "auth-2", "source-b", false, 1, 1, 0, 0, 2, nil),
	})
	if err != nil {
		t.Fatalf("insert events: %v", err)
	}

	resp, err := New(db).Analytics(ctx, Request{
		FromMS: fromMS,
		ToMS:   toMS,
		Filters: Filters{
			Models:        []string{"gpt-a"},
			AuthIndices:   []string{"auth-1"},
			IncludeFailed: &includeFailed,
		},
		Include: Include{Summary: true, EventsPage: &EventsPage{Limit: 10}},
	})
	if err != nil {
		t.Fatalf("analytics: %v", err)
	}
	if resp.Summary == nil || resp.Summary.TotalCalls != 1 || resp.Summary.FailureCalls != 0 {
		t.Fatalf("filtered summary = %#v", resp.Summary)
	}
	if resp.Events == nil || len(resp.Events.Items) != 1 || resp.Events.Items[0].EventHash != "filter-a" {
		t.Fatalf("filtered events = %#v", resp.Events)
	}

	includeFailed = true
	resp, err = New(db).Analytics(ctx, Request{
		FromMS:           fromMS,
		ToMS:             toMS,
		SearchQuery:      "raw-api-key",
		SearchAPIKeyHash: "api-key-auth-2",
		Filters: Filters{
			IncludeFailed: &includeFailed,
		},
		Include: Include{Summary: true, EventsPage: &EventsPage{Limit: 10}},
	})
	if err != nil {
		t.Fatalf("analytics api key hash search: %v", err)
	}
	if resp.Events == nil || len(resp.Events.Items) != 1 || resp.Events.Items[0].EventHash != "filter-c" {
		t.Fatalf("api key hash search events = %#v", resp.Events)
	}
}

func TestAnalyticsAccountAndAPIKeyStatsUseFullFilteredScope(t *testing.T) {
	db := newMonitoringTestStore(t)
	ctx := context.Background()
	fromMS := int64(1_778_050_000_000)
	toMS := fromMS + 60*60*1000

	events := []usage.Event{
		monitoringEvent("scope-a", fromMS+1_000, "gpt-a", "auth-1", "source-a", false, 10, 5, 0, 0, 15, nil),
		monitoringEvent("scope-b", fromMS+2_000, "gpt-a", "auth-1", "source-a", false, 20, 6, 0, 0, 26, nil),
		monitoringEvent("scope-c", fromMS+3_000, "gpt-b", "auth-1", "source-a", true, 1, 1, 0, 0, 2, nil),
	}
	for index := range events {
		events[index].AccountSnapshot = "team@example.com"
		events[index].AuthLabelSnapshot = "Team Account"
		events[index].APIKeyHash = "client-key-hash"
	}
	if _, err := db.InsertEvents(ctx, events); err != nil {
		t.Fatalf("insert events: %v", err)
	}

	resp, err := New(db).Analytics(ctx, Request{
		FromMS: fromMS,
		ToMS:   toMS,
		Include: Include{
			Summary:      true,
			AccountStats: true,
			APIKeyStats:  true,
			EventsPage:   &EventsPage{Limit: 1},
		},
	})
	if err != nil {
		t.Fatalf("analytics: %v", err)
	}
	if resp.Events == nil || len(resp.Events.Items) != 1 || !resp.Events.HasMore {
		t.Fatalf("events page = %#v", resp.Events)
	}
	if resp.Summary == nil || resp.Summary.TotalCalls != 3 || resp.Summary.FailureCalls != 1 {
		t.Fatalf("summary = %#v", resp.Summary)
	}
	if len(resp.AccountStats) != 1 || resp.AccountStats[0].Calls != 3 ||
		resp.AccountStats[0].FailureCalls != 1 || resp.AccountStats[0].TotalTokens != 43 {
		t.Fatalf("account stats = %#v", resp.AccountStats)
	}
	if len(resp.AccountStats[0].Models) != 2 {
		t.Fatalf("account model stats = %#v", resp.AccountStats[0].Models)
	}
	if len(resp.APIKeyStats) != 1 || resp.APIKeyStats[0].APIKeyHash != "client-key-hash" ||
		resp.APIKeyStats[0].Calls != 3 || resp.APIKeyStats[0].FailureCalls != 1 ||
		resp.APIKeyStats[0].TotalTokens != 43 {
		t.Fatalf("api key stats = %#v", resp.APIKeyStats)
	}
}

func TestAnalyticsSearchMatchesResolvedModelAndProjectID(t *testing.T) {
	db := newMonitoringTestStore(t)
	ctx := context.Background()
	fromMS := int64(1_778_000_000_000)
	toMS := fromMS + 60*60*1000

	event := monitoringEvent("search-new-fields", fromMS+1_000, "alias-search", "auth-1", "source-a", false, 1, 1, 0, 0, 2, nil)
	event.ResolvedModel = "gpt-resolved-search"
	event.AuthProjectIDSnapshot = "vertex-project-42"
	if _, err := db.InsertEvents(ctx, []usage.Event{event}); err != nil {
		t.Fatalf("insert events: %v", err)
	}

	for _, query := range []string{"gpt-resolved-search", "vertex-project-42"} {
		resp, err := New(db).Analytics(ctx, Request{
			FromMS:      fromMS,
			ToMS:        toMS,
			SearchQuery: query,
			Include:     Include{EventsPage: &EventsPage{Limit: 10}},
		})
		if err != nil {
			t.Fatalf("analytics search %q: %v", query, err)
		}
		if resp.Events == nil || len(resp.Events.Items) != 1 || resp.Events.Items[0].EventHash != "search-new-fields" {
			t.Fatalf("search %q events = %#v", query, resp.Events)
		}
	}
}

func TestAnalyticsSearchMatchesAccountSnapshotsWhenSourceIsMasked(t *testing.T) {
	db := newMonitoringTestStore(t)
	ctx := context.Background()
	fromMS := int64(1_778_060_000_000)
	toMS := fromMS + 60*60*1000

	alice := monitoringEvent("search-account-alice", fromMS+1_000, "gpt-a", "auth-a", "source-a", false, 1, 1, 0, 0, 2, nil)
	alice.Source = "ali***@example.com"
	alice.AccountSnapshot = "alice.smith@example.com"
	alice.AuthLabelSnapshot = "Alice Work Account"
	alice.AuthFileSnapshot = "alice.json"
	bob := monitoringEvent("search-account-bob", fromMS+2_000, "gpt-b", "auth-b", "source-b", false, 1, 1, 0, 0, 2, nil)
	bob.Source = "ali***@example.com"
	bob.AccountSnapshot = "alina.team@example.com"
	bob.AuthLabelSnapshot = "Alina Work Account"
	bob.AuthFileSnapshot = "alina.json"
	if _, err := db.InsertEvents(ctx, []usage.Event{alice, bob}); err != nil {
		t.Fatalf("insert events: %v", err)
	}

	for _, query := range []string{"ALICE.SMITH@example.com", "Alice Work Account", "alice.json"} {
		resp, err := New(db).Analytics(ctx, Request{
			FromMS:      fromMS,
			ToMS:        toMS,
			SearchQuery: query,
			Include:     Include{Summary: true, EventsPage: &EventsPage{Limit: 10}},
		})
		if err != nil {
			t.Fatalf("analytics search %q: %v", query, err)
		}
		if resp.Summary == nil || resp.Summary.TotalCalls != 1 {
			t.Fatalf("search %q summary = %#v", query, resp.Summary)
		}
		if resp.Events == nil || len(resp.Events.Items) != 1 || resp.Events.Items[0].EventHash != "search-account-alice" {
			t.Fatalf("search %q events = %#v", query, resp.Events)
		}
	}
}

func TestAnalyticsReportsZeroTokenModels(t *testing.T) {
	db := newMonitoringTestStore(t)
	ctx := context.Background()
	fromMS := int64(1_778_000_000_000)
	toMS := fromMS + 60*60*1000

	_, err := db.InsertEvents(ctx, []usage.Event{
		monitoringEvent("zero-a", fromMS+1_000, "gpt-zero", "auth-1", "source-a", false, 0, 0, 0, 0, 0, nil),
		monitoringEvent("zero-b", fromMS+2_000, "gpt-failed-zero", "auth-1", "source-a", true, 0, 0, 0, 0, 0, nil),
		monitoringEvent("zero-c", fromMS+3_000, "gpt-nonzero", "auth-1", "source-a", false, 1, 1, 0, 0, 2, nil),
	})
	if err != nil {
		t.Fatalf("insert events: %v", err)
	}

	resp, err := New(db).Analytics(ctx, Request{
		FromMS:  fromMS,
		ToMS:    toMS,
		Include: Include{Summary: true},
	})
	if err != nil {
		t.Fatalf("analytics: %v", err)
	}
	if resp.Summary == nil || len(resp.Summary.ZeroTokenModels) != 1 || resp.Summary.ZeroTokenModels[0] != "gpt-zero" {
		t.Fatalf("zero token models = %#v", resp.Summary)
	}

	resp, err = New(db).Analytics(ctx, Request{
		FromMS:  fromMS,
		ToMS:    toMS,
		Filters: Filters{ExcludeZeroTokens: true},
		Include: Include{Summary: true},
	})
	if err != nil {
		t.Fatalf("analytics with zero-token filter: %v", err)
	}
	if resp.Summary == nil || resp.Summary.ZeroTokenCalls != 0 || len(resp.Summary.ZeroTokenModels) != 0 {
		t.Fatalf("filtered zero token summary = %#v", resp.Summary)
	}
}

func TestAnalyticsAppliesFailedOnlyFilter(t *testing.T) {
	db := newMonitoringTestStore(t)
	ctx := context.Background()
	fromMS := int64(1_778_100_000_000)
	toMS := fromMS + 60*60*1000

	_, err := db.InsertEvents(ctx, []usage.Event{
		monitoringEvent("status-a", fromMS+1_000, "gpt-ok", "auth-1", "source-a", false, 10, 5, 0, 0, 15, nil),
		monitoringEvent("status-b", fromMS+2_000, "gpt-failed", "auth-1", "source-a", true, 1, 1, 0, 0, 2, nil),
	})
	if err != nil {
		t.Fatalf("insert events: %v", err)
	}

	resp, err := New(db).Analytics(ctx, Request{
		FromMS:  fromMS,
		ToMS:    toMS,
		Filters: Filters{FailedOnly: true},
		Include: Include{Summary: true, EventsPage: &EventsPage{Limit: 10}},
	})
	if err != nil {
		t.Fatalf("analytics: %v", err)
	}
	if resp.Summary == nil || resp.Summary.TotalCalls != 1 || resp.Summary.FailureCalls != 1 {
		t.Fatalf("summary = %#v", resp.Summary)
	}
	if resp.Events == nil || len(resp.Events.Items) != 1 || !resp.Events.Items[0].Failed {
		t.Fatalf("events = %#v", resp.Events)
	}
}

func TestAnalyticsAppliesAccountFallbackFilter(t *testing.T) {
	db := newMonitoringTestStore(t)
	ctx := context.Background()
	fromMS := int64(1_778_200_000_000)
	toMS := fromMS + 60*60*1000

	alice := monitoringEvent("account-alice", fromMS+1_000, "gpt-a", "auth-a", "source-a", false, 10, 5, 0, 0, 15, nil)
	alice.AccountSnapshot = "alice@example.com"
	alice.AuthLabelSnapshot = "Alice Auth"
	alice.Source = "alice-source"
	bob := monitoringEvent("account-bob", fromMS+2_000, "gpt-b", "auth-b", "source-b", false, 10, 5, 0, 0, 15, nil)
	bob.AccountSnapshot = "bob@example.com"
	bob.AuthLabelSnapshot = "Bob Auth"
	bob.Source = "bob-source"

	if _, err := db.InsertEvents(ctx, []usage.Event{alice, bob}); err != nil {
		t.Fatalf("insert events: %v", err)
	}

	resp, err := New(db).Analytics(ctx, Request{
		FromMS: fromMS,
		ToMS:   toMS,
		Filters: Filters{
			Accounts: []string{"alice@example.com"},
		},
		Include: Include{Summary: true, EventsPage: &EventsPage{Limit: 10}},
	})
	if err != nil {
		t.Fatalf("analytics: %v", err)
	}
	if resp.Summary == nil || resp.Summary.TotalCalls != 1 || resp.Summary.SuccessCalls != 1 {
		t.Fatalf("summary = %#v", resp.Summary)
	}
	if resp.Events == nil || len(resp.Events.Items) != 1 || resp.Events.Items[0].EventHash != "account-alice" {
		t.Fatalf("events = %#v", resp.Events)
	}

	resp, err = New(db).Analytics(ctx, Request{
		FromMS: fromMS,
		ToMS:   toMS,
		Filters: Filters{
			Accounts: []string{"Alice Auth"},
		},
		Include: Include{Summary: true, EventsPage: &EventsPage{Limit: 10}},
	})
	if err != nil {
		t.Fatalf("analytics auth label account filter: %v", err)
	}
	if resp.Summary == nil || resp.Summary.TotalCalls != 1 {
		t.Fatalf("auth label summary = %#v", resp.Summary)
	}
	if resp.Events == nil || len(resp.Events.Items) != 1 || resp.Events.Items[0].EventHash != "account-alice" {
		t.Fatalf("auth label events = %#v", resp.Events)
	}
}

func TestAnalyticsFilterOptionsIgnoreActiveScopeFilters(t *testing.T) {
	db := newMonitoringTestStore(t)
	ctx := context.Background()
	fromMS := int64(1_778_300_000_000)
	toMS := fromMS + 60*60*1000

	alice := monitoringEvent("option-alice", fromMS+1_000, "gpt-a", "auth-a", "source-a", false, 10, 5, 0, 0, 15, nil)
	alice.AccountSnapshot = "alice@example.com"
	alice.AuthLabelSnapshot = "Alice Auth"
	alice.AuthProviderSnapshot = "codex"
	alice.APIKeyHash = "key-alice"
	bob := monitoringEvent("option-bob", fromMS+2_000, "gpt-b", "auth-b", "source-b", false, 10, 5, 0, 0, 15, nil)
	bob.AccountSnapshot = "bob@example.com"
	bob.AuthLabelSnapshot = "Bob Auth"
	bob.AuthProviderSnapshot = "gemini"
	bob.APIKeyHash = "key-bob"

	if _, err := db.InsertEvents(ctx, []usage.Event{alice, bob}); err != nil {
		t.Fatalf("insert events: %v", err)
	}

	resp, err := New(db).Analytics(ctx, Request{
		FromMS: fromMS,
		ToMS:   toMS,
		Filters: Filters{
			Models:   []string{"gpt-a"},
			Accounts: []string{"alice@example.com"},
		},
		Include: Include{
			Summary:       true,
			FilterOptions: true,
		},
	})
	if err != nil {
		t.Fatalf("analytics: %v", err)
	}
	if resp.Summary == nil || resp.Summary.TotalCalls != 1 {
		t.Fatalf("summary should respect active filters: %#v", resp.Summary)
	}
	if resp.FilterOptions == nil {
		t.Fatal("filter options are nil")
	}
	if len(resp.FilterOptions.AccountStats) != 2 {
		t.Fatalf("account filter options should ignore active account/model filters: %#v", resp.FilterOptions.AccountStats)
	}
	if len(resp.FilterOptions.APIKeyStats) != 2 {
		t.Fatalf("api key filter options should ignore active account/model filters: %#v", resp.FilterOptions.APIKeyStats)
	}
	if len(resp.FilterOptions.ModelStats) != 2 {
		t.Fatalf("model filter options should ignore active account/model filters: %#v", resp.FilterOptions.ModelStats)
	}
	if len(resp.FilterOptions.ChannelShare) != 2 {
		t.Fatalf("channel/provider filter options should ignore active account/model filters: %#v", resp.FilterOptions.ChannelShare)
	}
}

func TestAnalyticsEventsPageReportsTotalCountWhilePaging(t *testing.T) {
	db := newMonitoringTestStore(t)
	ctx := context.Background()
	fromMS := int64(1_778_400_000_000)
	toMS := fromMS + 60*60*1000

	const total = 25
	events := make([]usage.Event, 0, total)
	for i := range total {
		events = append(events, monitoringEvent(
			fmt.Sprintf("total-%02d", i),
			fromMS+int64(i+1)*1_000,
			"gpt-a", "auth-1", "source-a", false, 1, 1, 0, 0, 2, nil,
		))
	}
	if _, err := db.InsertEvents(ctx, events); err != nil {
		t.Fatalf("insert events: %v", err)
	}

	// First page with summary enabled: total_count must reflect the full match
	// count, not the page size.
	resp, err := New(db).Analytics(ctx, Request{
		FromMS:  fromMS,
		ToMS:    toMS,
		Include: Include{Summary: true, EventsPage: &EventsPage{Limit: 10}},
	})
	if err != nil {
		t.Fatalf("analytics page 1: %v", err)
	}
	if resp.Events == nil || len(resp.Events.Items) != 10 || !resp.Events.HasMore {
		t.Fatalf("page 1 = %#v", resp.Events)
	}
	if resp.Events.TotalCount != total {
		t.Fatalf("page 1 total_count = %d, want %d", resp.Events.TotalCount, total)
	}
	if resp.Events.NextBeforeMS == 0 || resp.Events.NextBeforeID == 0 {
		t.Fatalf("page 1 cursor = ms %d id %d", resp.Events.NextBeforeMS, resp.Events.NextBeforeID)
	}

	// Second page without summary exercises the standalone count(*) branch and
	// must still report the full total, not the remaining count.
	beforeMS := resp.Events.NextBeforeMS
	beforeID := resp.Events.NextBeforeID
	resp2, err := New(db).Analytics(ctx, Request{
		FromMS: fromMS,
		ToMS:   toMS,
		Include: Include{
			EventsPage: &EventsPage{Limit: 10, BeforeMS: &beforeMS, BeforeID: &beforeID},
		},
	})
	if err != nil {
		t.Fatalf("analytics page 2: %v", err)
	}
	if resp2.Events == nil || len(resp2.Events.Items) != 10 || !resp2.Events.HasMore {
		t.Fatalf("page 2 = %#v", resp2.Events)
	}
	if resp2.Events.TotalCount != total {
		t.Fatalf("page 2 total_count = %d, want %d", resp2.Events.TotalCount, total)
	}
	if resp2.Events.Items[0].EventHash == resp.Events.Items[len(resp.Events.Items)-1].EventHash {
		t.Fatalf("page 2 overlaps page 1 boundary item")
	}
}

func TestAnalyticsEventsPageTotalCountRespectsFilters(t *testing.T) {
	db := newMonitoringTestStore(t)
	ctx := context.Background()
	fromMS := int64(1_778_500_000_000)
	toMS := fromMS + 60*60*1000

	events := make([]usage.Event, 0, 11)
	for i := range 8 {
		events = append(events, monitoringEvent(fmt.Sprintf("ok-%d", i), fromMS+int64(i+1)*1_000, "gpt-a", "auth-1", "source-a", false, 1, 1, 0, 0, 2, nil))
	}
	for i := range 3 {
		events = append(events, monitoringEvent(fmt.Sprintf("fail-%d", i), fromMS+int64(100+i)*1_000, "gpt-b", "auth-2", "source-b", true, 1, 1, 0, 0, 2, nil))
	}
	if _, err := db.InsertEvents(ctx, events); err != nil {
		t.Fatalf("insert events: %v", err)
	}

	all, err := New(db).Analytics(ctx, Request{FromMS: fromMS, ToMS: toMS, Include: Include{EventsPage: &EventsPage{Limit: 50}}})
	if err != nil {
		t.Fatalf("analytics all: %v", err)
	}
	if all.Events == nil || all.Events.TotalCount != 11 {
		t.Fatalf("all total_count = %#v", all.Events)
	}

	failed, err := New(db).Analytics(ctx, Request{FromMS: fromMS, ToMS: toMS, Filters: Filters{FailedOnly: true}, Include: Include{EventsPage: &EventsPage{Limit: 50}}})
	if err != nil {
		t.Fatalf("analytics failed only: %v", err)
	}
	if failed.Events == nil || failed.Events.TotalCount != 3 || len(failed.Events.Items) != 3 {
		t.Fatalf("failed total_count = %#v", failed.Events)
	}

	byModel, err := New(db).Analytics(ctx, Request{FromMS: fromMS, ToMS: toMS, Filters: Filters{Models: []string{"gpt-a"}}, Include: Include{EventsPage: &EventsPage{Limit: 50}}})
	if err != nil {
		t.Fatalf("analytics model filter: %v", err)
	}
	if byModel.Events == nil || byModel.Events.TotalCount != 8 {
		t.Fatalf("model total_count = %#v", byModel.Events)
	}
}

func TestAnalyticsEventsPageStableCursorAvoidsSkippingSameTimestamp(t *testing.T) {
	db := newMonitoringTestStore(t)
	ctx := context.Background()
	fromMS := int64(1_778_600_000_000)
	toMS := fromMS + 60*60*1000

	// Every event shares one timestamp_ms so the page boundary lands inside a
	// single millisecond. A timestamp-only cursor would skip the remaining
	// rows; the compound (timestamp_ms, id) cursor must page through all of
	// them without dropping or duplicating any.
	const total = 12
	sharedTS := fromMS + 5_000
	events := make([]usage.Event, 0, total)
	for i := range total {
		events = append(events, monitoringEvent(fmt.Sprintf("same-ts-%02d", i), sharedTS, "gpt-a", "auth-1", "source-a", false, 1, 1, 0, 0, 2, nil))
	}
	if _, err := db.InsertEvents(ctx, events); err != nil {
		t.Fatalf("insert events: %v", err)
	}

	svc := New(db)
	seen := make(map[string]bool, total)
	var beforeMS, beforeID int64
	pages := 0
	for {
		page := &EventsPage{Limit: 5}
		if beforeMS > 0 {
			ms := beforeMS
			id := beforeID
			page.BeforeMS = &ms
			page.BeforeID = &id
		}
		resp, err := svc.Analytics(ctx, Request{FromMS: fromMS, ToMS: toMS, Include: Include{EventsPage: page}})
		if err != nil {
			t.Fatalf("analytics page %d: %v", pages, err)
		}
		if resp.Events == nil {
			t.Fatalf("analytics page %d returned no events", pages)
		}
		if resp.Events.TotalCount != total {
			t.Fatalf("page %d total_count = %d, want %d", pages, resp.Events.TotalCount, total)
		}
		for _, item := range resp.Events.Items {
			if seen[item.EventHash] {
				t.Fatalf("duplicate event %s across pages", item.EventHash)
			}
			seen[item.EventHash] = true
		}
		pages++
		if !resp.Events.HasMore {
			break
		}
		beforeMS = resp.Events.NextBeforeMS
		beforeID = resp.Events.NextBeforeID
		if pages > total+2 {
			t.Fatal("pagination did not terminate")
		}
	}
	if len(seen) != total {
		t.Fatalf("collected %d unique events, want %d (same-timestamp rows were skipped)", len(seen), total)
	}
}

func newMonitoringTestStore(t *testing.T) *store.Store {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "usage.sqlite"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})
	return db
}

func monitoringEvent(
	hash string,
	timestampMS int64,
	model string,
	authIndex string,
	sourceHash string,
	failed bool,
	inputTokens int64,
	outputTokens int64,
	reasoningTokens int64,
	cachedTokens int64,
	totalTokens int64,
	latencyMS *int64,
) usage.Event {
	return usage.Event{
		EventHash:       hash,
		TimestampMS:     timestampMS,
		Timestamp:       time.UnixMilli(timestampMS).UTC().Format(time.RFC3339Nano),
		Model:           model,
		Endpoint:        "POST /v1/chat/completions",
		Method:          "POST",
		Path:            "/v1/chat/completions",
		AuthIndex:       authIndex,
		Source:          "user@example.com",
		SourceHash:      sourceHash,
		APIKeyHash:      "api-key-" + authIndex,
		AccountSnapshot: "user@example.com",
		InputTokens:     inputTokens,
		OutputTokens:    outputTokens,
		ReasoningTokens: reasoningTokens,
		CachedTokens:    cachedTokens,
		TotalTokens:     totalTokens,
		LatencyMS:       latencyMS,
		Failed:          failed,
		CreatedAtMS:     timestampMS,
	}
}
