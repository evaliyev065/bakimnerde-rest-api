# MongoDB kurulumu

Yerel MongoDB çalışırken:

```powershell
npm.cmd run db:setup
```

Farklı bağlantı için:

```powershell
$env:MONGODB_URI="mongodb://kullanici:parola@sunucu:27017"
$env:MONGODB_DATABASE="bakimnerde"
$env:DB_SEED_PASSWORD="Guclu-Test-Parolasi"
npm.cmd run db:setup
```

Komut idempotenttir; koleksiyonları ve indexleri oluşturur, örnek tenantları günceller ve mevcut operasyon verisini silmez.
