-- Minimal PostGIS stand-in for CI environments WITHOUT the postgis extension.
-- Implements just enough (point geography as text, haversine ST_DWithin/ST_Distance)
-- to exercise the schema, constraints and dispatch SQL. Production uses real PostGIS.
CREATE DOMAIN geography AS text;
CREATE FUNCTION ST_MakePoint(x double precision, y double precision) RETURNS text IMMUTABLE LANGUAGE sql AS $$ SELECT 'POINT(' || x || ' ' || y || ')' $$;
CREATE FUNCTION ST_SetSRID(g text, srid int) RETURNS text IMMUTABLE LANGUAGE sql AS $$ SELECT g $$;
CREATE FUNCTION _pt(g text, i int) RETURNS double precision IMMUTABLE LANGUAGE sql AS $$
  SELECT split_part(replace(replace(g,'POINT(',''),')',''),' ', i)::double precision $$;
CREATE FUNCTION ST_X(g geography) RETURNS double precision IMMUTABLE LANGUAGE sql AS $$ SELECT _pt(g,1) $$;
CREATE FUNCTION ST_Y(g geography) RETURNS double precision IMMUTABLE LANGUAGE sql AS $$ SELECT _pt(g,2) $$;
CREATE FUNCTION ST_Distance(a geography, b geography) RETURNS double precision IMMUTABLE LANGUAGE sql AS $$
  SELECT 2 * 6371008.8 * asin(least(1, sqrt(
    power(sin(radians(_pt(b,2) - _pt(a,2)) / 2), 2) +
    cos(radians(_pt(a,2))) * cos(radians(_pt(b,2))) * power(sin(radians(_pt(b,1) - _pt(a,1)) / 2), 2)))) $$;
CREATE FUNCTION ST_DWithin(a geography, b geography, d double precision) RETURNS boolean IMMUTABLE LANGUAGE sql AS $$
  SELECT ST_Distance(a, b) <= d $$;
CREATE FUNCTION ST_Covers(a geography, b geography) RETURNS boolean IMMUTABLE LANGUAGE sql AS $$ SELECT false $$;
CREATE FUNCTION ST_GeogFromText(t text) RETURNS geography IMMUTABLE LANGUAGE sql AS $$ SELECT t::geography $$;
