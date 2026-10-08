-- A user may link one owned image from the normal Files API to their profile.
ALTER TABLE _armadillo_users ADD COLUMN profile_photo_id TEXT;
