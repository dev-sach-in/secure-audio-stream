# Replace default player of dialer
### Switch to root user
```shell
su root
```

## Removing default player access
### Removing default recording access from RECORDINGS symbolic link
```shell
cd /var/www/html/
rm RECORDINGS
```
### Removing RECORDINGS Alias from httpd service
```shell
nano /etc/httpd/conf/httpd.conf
```
```shell
#if not commented, comment it 

#Alias /RECORDINGS "/var/spool/asterisk/monitorDONE/"
#<Directory "/var/spool/asterisk/monitorDONE/">
#Options Indexes MultiViews
#AllowOverride None
#Require all granted
#</Directory>
#-----------END-----------
```

## Installation
```shell
yum install git
```

```shell
mkdir -p /var/www/node && cd /var/www/node
```

```shell
git clone https://github.com/dev-sach-in/secure-audio-stream.git
```

```shell
cd /var/www/node/secure-audio-stream
```

```shell
chmod 775 install.sh
```

```shell
sh install.sh
```

##Updating Dialer
### Updating dialer recording links from reportings
```shell
nano /etc/astguiclient.conf
```
```shell
VARserver_domain => sampledomain.sample.com:5043
# add this after above line
VARrecording_domain => sampledomain.sample.com:5044
```

### update the following lines in following cron files
```shell
nano /usr/share/astguiclient/AST_CRON_audio_1_move_mix.pl
nano /usr/share/astguiclient/AST_CRON_audio_1_move_VDonly.pl
nano /usr/share/astguiclient/AST_CRON_audio_2_compress.pl
```
#### follow for all 3 files
```shell
# Update 1
# ------ START--------
#        if ( ($line =~ /^VARserver_domain/) )
#                {$VARserver_domain = $line;   $VARserver_domain =~ s/.*=//gi;}
# add below code after above code
        if ( ($line =~ /^VARrecording_domain/) )
                {$VARrecording_domain = $line;   $VARrecording_domain =~ s/.*=//gi;}
# ------ END--------


# Update 2
# ------ START--------
# $server_ip = $VARserver_ip;             # Asterisk server IP
# add below code after above code
$server_ip = $VARrecording_domain;
# ------ END--------
```


### Update recording old records
```shell
mysql
```
```shell
update asterisk.recording_log set location = REPLACE(location, 'https://sampledomain.sample.com:5043','https://sampledomain.sample.com:5044');
```

## Updating IPTABLES
```shell
iptables-save > /home/User-3184/iptables.txt
iptables-save > /home/User-3184/iptables.txt.orig
```
```shell
nano /home/User-3184/iptables.txt
```
```shell
# -A INPUT -p tcp -m tcp --dport 5043 -m comment --comment "Accept Web Port" -j ACCEPT
# add below code after above code
-A INPUT -p tcp -m tcp --dport 5044 -m comment --comment "Accept Web Port" -j ACCEPT
```
```shell
#restore iptables rules
iptables-restore < /home/User-3184/iptables.txt
iptables-save > /etc/sysconfig/iptables
iptables -nvL
```

