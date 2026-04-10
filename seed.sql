-- Run after schema.sql. Password for all three demo accounts: Password123!
-- Replace hashes in production.
INSERT INTO users (full_name, email, password_hash, role, phone)
VALUES
('Admin User', 'admin@doktornearme.co.za', '$2a$10$1vJ9M8l80YgA7R4j9IuT0eG6mwm5tV7hmg53i3T8NPMnAb6aG7l2m', 'admin', '0000000000'),
('Affiliate User', 'affiliate@doktornearme.co.za', '$2a$10$1vJ9M8l80YgA7R4j9IuT0eG6mwm5tV7hmg53i3T8NPMnAb6aG7l2m', 'affiliate', '0000000000'),
('Practitioner User', 'practitioner@doktornearme.co.za', '$2a$10$1vJ9M8l80YgA7R4j9IuT0eG6mwm5tV7hmg53i3T8NPMnAb6aG7l2m', 'practitioner', '0000000000')
ON CONFLICT (email) DO NOTHING;

INSERT INTO affiliates (user_id, referral_code)
SELECT id, 'AFF001' FROM users WHERE email = 'affiliate@doktornearme.co.za'
ON CONFLICT (referral_code) DO NOTHING;

INSERT INTO practitioners (user_id, practice_name, specialty, location)
SELECT id, 'Demo Practice', 'General Practice', 'Bela-Bela'
FROM users WHERE email = 'practitioner@doktornearme.co.za'
ON CONFLICT (user_id) DO NOTHING;
