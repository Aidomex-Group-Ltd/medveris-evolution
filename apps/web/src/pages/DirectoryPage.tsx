import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CircleMarker, MapContainer, Popup, TileLayer, useMap, useMapEvents } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, Select } from "@medveris/ui";
import { BrandMark } from "../components/BrandMark";
import { api } from "../lib/api";
import { useAppEnvironment } from "../lib/environment";
import { useQuery } from "../lib/useQuery";

export interface Branch {
  id: string;
  name: string;
  isPrimary: boolean;
  latitude: number | null;
  longitude: number | null;
  city: string | null;
  addressLine1: string | null;
  addressLine2?: string | null;
  region?: string | null;
  district?: string | null;
  locality?: string | null;
  country?: string | null;
  locationStatus: string;
  openingHours: Record<string, string>;
}

export interface Service { id: string; code: string; name: string; category: string }
export interface Capability { code: string; name: string; status: string }

export interface PublicFacility {
  id: string;
  publicId: string;
  name: string;
  facilityType: string;
  description: string | null;
  country: string;
  region: string | null;
  district: string | null;
  locality: string | null;
  publicPhone: string | null;
  publicEmail: string | null;
  website: string | null;
  medverisParticipation: string;
  credentialStatus: string;
  capabilityStatus: string;
  lastConfirmedOn: string | null;
  claimed: boolean;
  services: Service[];
  capabilities: Capability[];
  branches: Branch[];
  distanceKm: number | null;
  sponsored: boolean;
  promotion: { campaignId: string; surface: string; label: string } | null;
}

interface DirectoryResponse {
  facilities: PublicFacility[];
  sponsored: PublicFacility[];
  total: number;
  ranking: { organic: string[]; sponsored: string; distance: string };
}

interface MetaResponse {
  geographies: { country: string; region: string | null; district: string | null }[];
  serviceCategories: string[];
  facilities: PublicFacility[];
  facilityTypes: string[];
  defaults: { country: string; maxRadiusKm: number };
}

interface MapConfig {
  tileUrl: string;
  attribution: string;
  minZoom: number;
  maxZoom: number;
  geolocationEnabled: boolean;
  privacy: string;
}

interface Filters {
  q: string;
  country: string;
  district: string;
  facilityType: string;
  service: string;
  lat: string;
  lng: string;
  radiusKm: string;
  sort: string;
}

const EMPTY: Filters = { q: "", country: "", district: "", facilityType: "", service: "", lat: "", lng: "", radiusKm: "", sort: "relevance" };

function track(eventType: string, facility: PublicFacility, surface: string) {
  void api("/public/directory/events", {
    method: "POST",
    body: { eventType, facilityPublicId: facility.publicId, campaignId: facility.promotion?.campaignId ?? null, surface },
  }).catch(() => undefined);
}

function primaryBranch(facility: PublicFacility): Branch | null {
  return facility.branches.find((branch) => branch.latitude != null && branch.longitude != null) ?? null;
}

function FitBounds({ points }: { points: { lat: number; lng: number }[] }) {
  const map = useMap();
  useEffect(() => {
    if (!points.length) return;
    if (points.length === 1) {
      map.setView([points[0]!.lat, points[0]!.lng], 13);
      return;
    }
    const lats = points.map((point) => point.lat);
    const lngs = points.map((point) => point.lng);
    map.fitBounds([[Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)]], { padding: [32, 32], maxZoom: 14 });
  }, [map, points]);
  return null;
}

function MapClick({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(event) {
      onPick(event.latlng.lat, event.latlng.lng);
    },
  });
  return null;
}

export function DirectoryPage() {
  const environment = useAppEnvironment();
  const navigate = useNavigate();
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const impressionSent = useRef(new Set<string>());

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (applied.q) params.set("q", applied.q);
    if (applied.country) params.set("country", applied.country);
    if (applied.district) params.set("district", applied.district);
    if (applied.facilityType) params.set("facilityType", applied.facilityType);
    if (applied.service) params.set("service", applied.service);
    if (applied.lat && applied.lng) {
      params.set("lat", applied.lat);
      params.set("lng", applied.lng);
      if (applied.radiusKm) params.set("radiusKm", applied.radiusKm);
    }
    params.set("sort", applied.sort);
    params.set("limit", "24");
    return `/public/directory/facilities?${params.toString()}`;
  }, [applied]);

  const results = useQuery<DirectoryResponse>(query);
  const meta = useQuery<MetaResponse>("/public/directory/meta");
  const mapConfig = useQuery<MapConfig>("/public/directory/map-config");

  const all = useMemo(() => [...(results.data?.sponsored ?? []), ...(results.data?.facilities ?? [])], [results.data]);
  const points = useMemo(() => {
    return all.flatMap((facility) => {
      const branch = primaryBranch(facility);
      return branch ? [{ lat: branch.latitude!, lng: branch.longitude!, facility }] : [];
    });
  }, [all]);

  useEffect(() => {
    for (const facility of results.data?.sponsored ?? []) {
      if (impressionSent.current.has(facility.id)) continue;
      impressionSent.current.add(facility.id);
      track("impression", facility, "search");
    }
  }, [results.data]);

  function apply(event?: FormEvent) {
    event?.preventDefault();
    setApplied({ ...filters });
  }

  function useMyLocation() {
    if (!navigator.geolocation) {
      setLocationError("This browser does not expose a location interface.");
      return;
    }
    setLocating(true);
    setLocationError(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const next = { ...filters, lat: position.coords.latitude.toFixed(6), lng: position.coords.longitude.toFixed(6), radiusKm: filters.radiusKm || "25", sort: "distance" };
        setFilters(next);
        setApplied(next);
        setLocating(false);
      },
      () => {
        setLocationError("Location permission was denied. Pick a point on the map instead.");
        setLocating(false);
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300_000 },
    );
  }

  function pickPoint(lat: number, lng: number) {
    const next = { ...filters, lat: lat.toFixed(6), lng: lng.toFixed(6), radiusKm: filters.radiusKm || "25", sort: "distance" };
    setFilters(next);
    setApplied(next);
  }

  function clearLocation() {
    const next = { ...filters, lat: "", lng: "", radiusKm: "", sort: "relevance" };
    setFilters(next);
    setApplied(next);
  }

  return (
    <div className="mv-public">
      <header className="mv-public__header">
        <Link to="/" className="mv-brand" aria-label="Medveris home"><BrandMark /><span>Medveris<small>Public provider directory</small></span></Link>
        <nav className="mv-row" aria-label="Public navigation">
          <Link to="/directory">Find care</Link>
          <Link to="/login">Sign in</Link>
        </nav>
      </header>
      <main className="mv-public__main">
        <section className="mv-stack">
          <div>
            <p className="mv-eyebrow">Verified directory and map</p>
            <h1>Find a health facility</h1>
            <p className="mv-muted">Search published listings. Paid placements are labelled Sponsored and never change verification, capability evidence or emergency routing.</p>
          </div>
          {environment.synthetic ? (
            <Notice tone="info" title="Synthetic demonstration">
              All facilities, phone numbers and coordinates in this release are synthetic test data. In an emergency, contact local emergency services directly.
            </Notice>
          ) : null}
          <Card title="Search and filters">
            <form className="mv-form-grid" onSubmit={apply}>
              <Field label="Search by name or service">
                <Input value={filters.q} onChange={(event) => setFilters({ ...filters, q: event.target.value })} placeholder="e.g. maternity, pharmacy" />
              </Field>
              <Field label="Country">
                <Input value={filters.country} onChange={(event) => setFilters({ ...filters, country: event.target.value })} placeholder="Uganda" />
              </Field>
              <Field label="District">
                <Input value={filters.district} onChange={(event) => setFilters({ ...filters, district: event.target.value })} placeholder="Kampala" />
              </Field>
              <Field label="Facility type">
                <Select value={filters.facilityType} onChange={(event) => setFilters({ ...filters, facilityType: event.target.value })}>
                  <option value="">All types</option>
                  {(meta.data?.facilityTypes ?? []).map((type) => <option key={type} value={type}>{type.replaceAll("-", " ")}</option>)}
                </Select>
              </Field>
              <Field label="Service category">
                <Select value={filters.service} onChange={(event) => setFilters({ ...filters, service: event.target.value })}>
                  <option value="">All services</option>
                  {(meta.data?.serviceCategories ?? []).map((category) => <option key={category} value={category}>{category.replaceAll("-", " ")}</option>)}
                </Select>
              </Field>
              <Field label="Sort">
                <Select value={filters.sort} onChange={(event) => setFilters({ ...filters, sort: event.target.value })}>
                  <option value="relevance">Relevance and freshness</option>
                  <option value="distance" disabled={!filters.lat || !filters.lng}>Straight-line distance</option>
                </Select>
              </Field>
              <div className="mv-row mv-form-actions">
                <Button type="submit">Search</Button>
                <Button variant="secondary" onClick={useMyLocation} disabled={locating}>{locating ? "Locating…" : "Use my location"}</Button>
                {filters.lat ? <Button variant="ghost" onClick={clearLocation}>Clear location</Button> : null}
                <Button variant="ghost" onClick={() => { setFilters(EMPTY); setApplied(EMPTY); }}>Reset</Button>
              </div>
            </form>
            {locationError ? <Notice tone="warning">{locationError}</Notice> : null}
            {filters.lat ? (
              <p className="mv-small mv-muted">
                Searching within {filters.radiusKm || "25"} km of {Number(filters.lat).toFixed(3)}, {Number(filters.lng).toFixed(3)}. Distances are straight-line only, not driving distance.
              </p>
            ) : null}
          </Card>

          <div className="mv-directory-layout">
            <Card title={`Results${results.data ? ` (${results.data.total})` : ""}`} description="Organic results are ordered by match and freshness. Sponsored placements appear separately and are labelled.">
              {results.loading && !results.data ? <LoadingState label="Loading listings" /> : results.error ? <ErrorState message={results.error} onRetry={results.reload} /> : !all.length ? <EmptyState title="No matching facilities" description="Adjust the filters or clear the location radius." /> : (
                <div className="mv-stack">
                  {(results.data?.sponsored ?? []).length ? (
                    <div className="mv-stack">
                      <h3 className="mv-small mv-muted">Sponsored placements</h3>
                      {results.data!.sponsored.map((facility) => <FacilityCard key={facility.id} facility={facility} onOpen={() => { track("detail-open", facility, "search"); navigate(`/directory/${facility.publicId}`); }} />)}
                    </div>
                  ) : null}
                  {(results.data?.facilities ?? []).map((facility) => <FacilityCard key={facility.id} facility={facility} onOpen={() => { track("detail-open", facility, "search"); navigate(`/directory/${facility.publicId}`); }} />)}
                </div>
              )}
            </Card>
            <Card title="Map" description="Only published facility coordinates are shown. Your browser location is used transiently and is not stored by Medveris.">
              {mapConfig.loading ? <LoadingState label="Loading map" /> : mapConfig.error ? <ErrorState message={mapConfig.error} onRetry={mapConfig.reload} /> : mapConfig.data ? (
                <div className="mv-map" aria-label="Map of published facilities">
                  <MapContainer center={[0.3476, 32.5825]} zoom={7} minZoom={mapConfig.data.minZoom} maxZoom={mapConfig.data.maxZoom} className="mv-map__canvas" scrollWheelZoom>
                    <TileLayer url={mapConfig.data.tileUrl} attribution={mapConfig.data.attribution} />
                    <FitBounds points={points} />
                    <MapClick onPick={pickPoint} />
                    {points.map(({ lat, lng, facility }) => (
                      <CircleMarker
                        key={facility.id}
                        center={[lat, lng]}
                        radius={facility.sponsored ? 11 : 8}
                        pathOptions={facility.sponsored ? { color: "#8a5a00", fillColor: "#f0b429", fillOpacity: 0.9 } : { color: "#0f6b5c", fillColor: "#2f9e82", fillOpacity: 0.85 }}
                        eventHandlers={{ click: () => track("pin-interaction", facility, "map") }}
                      >
                        <Popup>
                          <strong>{facility.name}</strong>
                          <div>{facility.facilityType.replaceAll("-", " ")}</div>
                          <div>{facility.district ?? facility.region ?? facility.country}</div>
                          {facility.sponsored ? <div><em>Sponsored</em></div> : null}
                          <Link to={`/directory/${facility.publicId}`} onClick={() => track("detail-open", facility, "map")}>View listing</Link>
                        </Popup>
                      </CircleMarker>
                    ))}
                  </MapContainer>
                  <p className="mv-small mv-muted">{mapConfig.data.privacy} Distance is straight-line only. Click the map to search near a point.</p>
                </div>
              ) : null}
            </Card>
          </div>
          <Notice tone="neutral" title="Ranking disclosure">
            Organic: {(results.data?.ranking.organic ?? ["service and capability match", "freshness", "distance", "name"]).join(", ")}. {results.data?.ranking.sponsored ?? "Paid placements are labelled and rotated."} {results.data?.ranking.distance ?? ""}
          </Notice>
        </section>
      </main>
    </div>
  );
}

function FacilityCard({ facility, onOpen }: { facility: PublicFacility; onOpen: () => void }) {
  const branch = primaryBranch(facility);
  return (
    <article className="mv-directory-card">
      <div className="mv-row mv-row--between">
        <div>
          <h3>{facility.name}</h3>
          <p className="mv-small mv-muted">
            {facility.facilityType.replaceAll("-", " ")} · {branch?.city ?? facility.locality ?? facility.district ?? facility.region ?? facility.country}
            {facility.distanceKm != null ? ` · ${facility.distanceKm} km away (straight line)` : ""}
          </p>
        </div>
        <div className="mv-row">
          {facility.sponsored ? <Badge tone="warning">Sponsored</Badge> : null}
          {facility.credentialStatus === "verified" ? <Badge tone="success">Credentials verified</Badge> : null}
          {facility.claimed ? <Badge tone="info">Claimed</Badge> : null}
        </div>
      </div>
      {facility.description ? <p>{facility.description}</p> : null}
      <div className="mv-row mv-wrap">
        {facility.services.slice(0, 6).map((service) => <Badge key={service.id}>{service.name}</Badge>)}
      </div>
      <div className="mv-row">
        <Button size="sm" onClick={onOpen}>View listing</Button>
        {facility.publicPhone ? <a href={`tel:${facility.publicPhone}`} onClick={() => track("contact-click", facility, "search")} className="mv-button mv-button--secondary mv-button--sm">Call</a> : null}
      </div>
    </article>
  );
}

export function DirectoryFooter() {
  const { synthetic } = useAppEnvironment();
  return (
    <footer className="mv-public__footer">
      <p>Medveris public directory ·{synthetic ? " Listings are synthetic." : ""} Sponsored placements are paid and labelled; payment never changes verification or emergency criteria.</p>
    </footer>
  );
}
