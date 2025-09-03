# Syconn-Neuroglancer Server Setup

This guide explains how to set up the **Syconn Neuroglancer server** on any VM or workstation.  
Below, we’ll go through the process using the **MPI HPC Cloud** as an example.

---

## 1. Setup Server (MPI HPC Cloud)

> ⚠️ Although this guide uses the MPI HPC Cloud, the setup works on any VM or workstation.

1. Sign into the [MPI HPC Cloud](https://docs.mpcdf.mpg.de/doc/cloud/index.html).
2. Create an instance and volume following the guidelines.

---

### 1.1 Create Volume

1. Navigate to **Volumes > Volumes**.
2. Click **Create volume**.
3. Choose a name and description (e.g. `Syconn Web volume`).
4. Set the volume size (e.g. `128 GiB`).

---

### 1.2 Create Key Pair

1. Navigate to **Compute > Key Pairs**.
2. Click **Create Key Pair**.
3. Enter a name and select **SSH key** type.
4. Create a new SSH key and upload the public key.

---

### 1.3 Create Instance

1. Navigate to **Compute > Instances**.
2. Click **Create Instance**.
3. Choose a name (e.g. `syconn-web`).
4. Select your **Key Pair**.
5. Choose an image (e.g. `Ubuntu 24.04`).
6. Attach the previously created volume.
7. Select a private network.

> 💡 To make the VM reachable from the global network, contact the **MPI Helpdesk**.  
> The maintainer must also create a **Floating IP** under **Network > Floating IPs**.

---

## 2. VM Setup

Once the instance is running, connect to it using your SSH key:

```bash
ssh -i your_key.pem ubuntu@<floating-ip>
```

> ⚠️  Make sure to connect through ssh behind the official MPI gates, in case you are outside of an MPI network. 

---

### 2.1 Create User

It’s recommended to run the server from a dedicated user.

```bash
# Create user
sudo useradd -m neuro

# Add to sudoers
sudo usermod -aG sudo neuro

# Switch user
su - neuro
```

Install required packages (if not already available):

```bash
sudo apt update -y
sudo apt install -y git python3 python3-pip git
```

---

### 2.2 Mounts

The VM requires Cajal mounts to function. Request these from the MPI Helpdesk.
Mount them under `/new_mounts`.

Here is a complete list of the paths:

* /cajal/nvmescratch/projects/data/songbird_tmp -> /new_mounts/nvmescratch/
* /cajal/nvmescratch/projects/data/songbird -> /new_mounts/wholebrain/songbird
* /cajal/nvmescratch/projects/from_ssdscratch/songbird -> /new_mounts/ssdscratch/songbird


> ⚠️ Ensure your VM user has the same primary group ID (13600) as the folders on Cajal:
Create a group with GID `13600`, then assign it as the user’s primary group.

---

### 2.3 Install & Configure Nginx

```bash
# Install nginx
sudo apt update -y && sudo apt install -y nginx

# Check installation
nginx -v

# Verify it’s running
sudo systemctl status nginx
sudo systemctl start nginx
```

Add the correct configuration under `/etc/nginx/conf.d/`
(Config files are available in `/syconn-neuroglancer/neuroglancer/python/neuroglancer/confs/`).

Restart nginx:
```bash
sudo systemctl restart nginx
```
--- 
### 2.4 Certbot (HTTPS Certificates)

Use Certbot to enable HTTPS.

```bash
# Install certbot
sudo snap install --classic certbot
# or alternatively
sudo apt-get install certbot

# Prepare certbot
sudo ln -s /snap/bin/certbot /usr/bin/certbot

# Obtain certificate
sudo certbot certonly --standalone
```
---

### 2.5 Environment Setup

You can use any package manager, but mamba or uv is recommended.

```bash
# Create project directory
mkdir ~/neuro && cd ~/neuro

# Create environment
mamba create -n syco python=3.7.10
conda activate syco
```

Clone and install **SyConn**

```bash
git clone https://gitlab.mpcdf.mpg.de/pschuber/SyConn.git
cd SyConn
git checkout web
python -m pip install -r requirements.txt
python -m pip install -e .
cd ..
```

Clone and run **Syconn-Neuroglancer**

```bash
git clone https://gitlab.mpcdf.mpg.de/hashirah/syconn-neuroglancer.git
cd syconn-neuroglancer/neuroglancer/python/neuroglancer/
git checkout update_neuroglancer
python -i server.py
```

---

### 🎉 Done!

Your Syconn-Neuroglancer server should now be running.

--- 

### 📬 Contact

For questions or issues, address them to [Andrei Mancu](mailto:andrei.mancu@bi.mpg.de) or [Joergen Kornfeld](](mailto:joergen.kornfeld@bi.mpg.de)). 


